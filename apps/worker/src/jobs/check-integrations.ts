import { recordHealth, systemContext, type IntegrationKind } from '@rawr/db'
import { z } from 'zod'
import { owner } from '../db.ts'
import { APP_BASE, INTERNAL_SECRET } from '../env.ts'
import { AccountFailures, defineJob } from './registry.ts'

/** One provider test. Long enough for a slow provider, short enough that one
 *  unresponsive one cannot hold up every integration behind it. */
const TEST_TIMEOUT_MS = 30_000

/** F6 §1's health check on a schedule.
 *
 *  The test calls live in the web app, next to the OAuth client and the provider
 *  modules, so the worker asks it to run them the same way it asks for a mailbox
 *  pass. Duplicating the provider clients in two processes would mean two places
 *  that hold somebody's API key.
 *
 *  What this buys: a credential revoked at the provider turns the health red within
 *  one cycle, which is exactly what F6's definition of done asks for, rather than
 *  the next time somebody happens to open Settings. */
export const checkIntegrations = defineJob({
  name: 'integrations.health',
  schema: z.object({}),
  retryLimit: 2,
  retryDelaySeconds: 300,
  audience: 'select account_id from integration where secret_ref is not null',
  handle: async () => {
    // Only integrations somebody has actually configured. Testing an unconfigured
    // one would turn "nobody has set this up" into "this is broken", which is a
    // different and less useful thing to see.
    const rows = await owner<{ kind: IntegrationKind; account_id: string }[]>`
      select i.kind, i.account_id
        from integration i
       where i.secret_ref is not null`

    // One integration's failure never stops the others. Failures are grouped by
    // account, so each account gets one dead letter that names every integration
    // of its own that is down.
    const failures = new Map<string, string>()
    for (const row of rows) {
      const failure = await probe(row).catch((cause: unknown) => `${row.kind}: ${errorMessage(cause)}`)
      if (failure === null) continue
      const prior = failures.get(row.account_id)
      failures.set(row.account_id, prior ? `${prior}; ${failure}` : failure)
    }
    if (failures.size > 0) throw new AccountFailures(failures)
  },
})

/** Returns the failure to report, or null when the integration answered ok.
 *
 *  A refused call is not an integration failure: the app answers 404 to any caller
 *  without the secret, so a wrong secret is a fault in the worker's configuration,
 *  and marking every integration red for it would send somebody to the wrong
 *  settings page. Everything else is recorded on the integration, which is where
 *  Settings reads health from. */
const probe = async (row: { kind: IntegrationKind; account_id: string }): Promise<string | null> => {
  let detail: string
  try {
    const response = await fetch(`${APP_BASE}/api/internal/integration-health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
      body: JSON.stringify({ accountId: row.account_id, kind: row.kind }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    if (response.status === 404) {
      return `${row.kind}: the health check was refused: wrong or missing secret`
    }
    const body = (await response.json().catch(() => null)) as { ok?: unknown; detail?: unknown } | null
    if (body?.ok === true) return null
    detail = typeof body?.detail === 'string' ? body.detail : `the app answered ${response.status} without a result`
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      detail = `the check timed out after ${TEST_TIMEOUT_MS / 1000} seconds`
    } else {
      console.error(`[integrations.health] ${row.kind} could not reach the app:`, cause)
      detail = reachReason(cause)
    }
  }
  await recordHealth(systemContext(row.account_id), row.kind, { ok: false, error: detail })
  return `${row.kind}: ${detail}`
}

/** A plain sentence for a failed call to the app. Node's own text is never stored:
 *  it names internal addresses and ports, and the code says what happened. */
const reachReason = (cause: unknown): string => {
  const error = cause as { code?: unknown; cause?: { code?: unknown } } | null
  const id = [error?.code, error?.cause?.code].find((value): value is string => typeof value === 'string') ?? ''
  if (id === 'ECONNREFUSED') return 'the app refused the connection.'
  if (id === 'ENOTFOUND' || id === 'EAI_AGAIN') return 'the app was not found (DNS).'
  if (id === 'ETIMEDOUT' || id === 'UND_ERR_CONNECT_TIMEOUT' || id === 'ESOCKETTIMEDOUT') return 'the app did not answer in time.'
  if (id === 'ECONNRESET' || id === 'EPIPE') return 'the connection to the app was reset.'
  if (id.includes('CERT') || id === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'the certificate of the app could not be verified.'
  return 'the app could not be reached.'
}

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
