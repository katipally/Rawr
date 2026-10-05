import { randomUUID } from 'node:crypto'
import { recordDeadLetter, recordOutboundCall, type IntegrationKind, type AccountContext } from '@rawr/db'

/** The half of F6 §1 that is about talking to somebody else's server.
 *
 *  Every provider call in Rawr goes through `attempt`, so retry, backoff, jitter,
 *  the finite ceiling and the dead-letter row exist once rather than per
 *  integration. What varies between providers is the URL and the shape of the
 *  answer; nothing about how failure is handled varies at all. */

export type ProviderError = Error & {
  /** Set when the provider rejected the credential rather than failing. That stops
   *  the retry loop: no number of attempts fixes a revoked key. */
  disconnected?: boolean
  status?: number
  /** What the provider's Retry-After asked for, so the next try waits that long
   *  instead of guessing. */
  retryAfterMs?: number
}

export const providerError = (
  message: string,
  options: { status?: number; disconnected?: boolean; retryAfterMs?: number | null } = {},
): ProviderError => {
  const error = new Error(message) as ProviderError
  if (options.status !== undefined) error.status = options.status
  if (options.disconnected) error.disconnected = true
  if (options.retryAfterMs) error.retryAfterMs = options.retryAfterMs
  return error
}

/** Google reports a quota as a 403 whose reason is rateLimitExceeded or
 *  userRateLimitExceeded, and Zoom, Slack and the rest as a 429. Telling them from
 *  a rejected credential matters: acting on the 403 disconnects a working
 *  integration for being busy. */
export const isRateLimited = (status: number, body: string): boolean =>
  status === 429 || (status === 403 && /rate.?limit|quota/i.test(body))

/** A credential rejection, in the two shapes every provider uses. */
export const isCredentialRejection = (status: number, body = ''): boolean =>
  (status === 401 || status === 403) && !isRateLimited(status, body)

/** Retry-After is seconds or an HTTP date. */
const retryAfterMs = (header: string | null): number | null => {
  if (!header) return null
  const seconds = Number(header)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

/** A wait longer than this is not spent holding a request or a worker open; the
 *  answer is handed back and whatever queued the work tries again later. */
const MAX_INLINE_WAIT_MS = 30_000

/** Sends a request again, up to `attempts` times in all, while the provider says it
 *  is too busy: Google's quota guidance is exponential backoff from one second, and
 *  Retry-After is honoured when given. A refused request was not processed, so
 *  repeating it cannot do the work twice. A 5xx is repeated only when the caller
 *  says the request is safe to repeat, because a POST that failed after the
 *  provider acted would otherwise happen twice. */
export const sendWithBackoff = async (
  send: () => Promise<Response>,
  { attempts = 4, repeatable = false }: { attempts?: number; repeatable?: boolean } = {},
): Promise<Response> => {
  for (let n = 1; ; n++) {
    const response = await send()
    if (response.ok || n >= attempts) return response
    const limited = isRateLimited(response.status, response.status === 403 ? await response.clone().text() : '')
    if (!limited && !(repeatable && response.status >= 500)) return response
    const asked = retryAfterMs(response.headers.get('retry-after'))
    if (asked && asked > MAX_INLINE_WAIT_MS) return response
    const base = 1000 * 2 ** (n - 1)
    await sleep(asked ?? base + Math.random() * base)
  }
}

export type AttemptOptions = {
  ctx: AccountContext
  kind: IntegrationKind
  jobName: string
  payload: Record<string, unknown>
  /** Total tries, not retries. Finite by construction: F6 §1 forbids a loop. */
  attempts?: number
  /** Set where the caller already wrapped this in `once`, which ledgers the call
   *  itself. Without it one HTTP request would be counted twice. */
  claimed?: boolean
}

const BASE_DELAY_MS = 500

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Exponential backoff with jitter, a ceiling, and a dead letter at the end that
 *  carries the payload and the provider's real error so it can be replayed. */
export const attempt = async <T>(options: AttemptOptions, run: () => Promise<T>): Promise<T> => {
  const total = options.attempts ?? 4
  let last: unknown = null

  for (let n = 1; n <= total; n++) {
    try {
      const answer = await run()
      if (!options.claimed) {
        // The ledger the Insights panel counts. A random key because this is a
        // record of a call that was made, not a claim on one: a derived key would
        // collapse two real enrichments of the same contact into one row.
        await recordOutboundCall(options.ctx, {
          key: `${options.jobName}:${randomUUID()}`,
          operation: options.jobName,
        }).catch(() => {
          // The call itself succeeded. Losing its ledger row is not worth failing
          // the work that provoked it.
        })
      }
      return answer
    } catch (cause) {
      last = cause
      // A rejected credential does not improve with waiting. Fail out now so the
      // health state turns red this cycle rather than in twenty minutes.
      if ((cause as ProviderError).disconnected) break
      if (n === total) break
      const base = BASE_DELAY_MS * 2 ** (n - 1)
      const asked = (cause as ProviderError).retryAfterMs
      await sleep(asked ? Math.min(asked, MAX_INLINE_WAIT_MS) : base + Math.random() * base)
    }
  }

  const error = last instanceof Error ? last : new Error(String(last))
  await recordDeadLetter(options.ctx, {
    jobName: options.jobName,
    payload: options.payload,
    error: error.message,
    attempts: total,
  }).catch(() => {
    // The database is the last place to record this. If it is unreachable too,
    // there is nothing further to do and the throw below still surfaces it.
  })
  throw error
}

export type JsonRequest = {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}

/** One JSON call, with the provider's own error text kept intact. A generic
 *  "request failed" is exactly what F6 §1 forbids: the health panel has to be able
 *  to show what the provider actually said. */
export const json = async <T>(request: JsonRequest): Promise<T> => {
  const response = await fetch(request.url, {
    method: request.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...request.headers,
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    signal: AbortSignal.timeout(request.timeoutMs ?? 15_000),
  })

  const text = await response.text()
  if (!response.ok) {
    throw providerError(`${response.status} ${response.statusText}: ${text.slice(0, 400)}`, {
      status: response.status,
      disconnected: isCredentialRejection(response.status, text),
      retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
    })
  }
  return (text ? JSON.parse(text) : null) as T
}

export type ConnectionTest = { ok: boolean; detail: string }
