import { z } from 'zod'
import { owner } from '../db.ts'
import { INTERNAL_SECRET } from '../env.ts'
import { defineJob } from './registry.ts'

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
  handle: async () => {
    const base = process.env.RAWR_INTERNAL_URL ?? 'http://localhost:3000'

    // Only integrations somebody has actually configured. Testing an unconfigured
    // one would turn "nobody has set this up" into "this is broken", which is a
    // different and less useful thing to see.
    // One credential serves the whole organisation now, so it is tested once,
    // not once per account. The test still runs *inside* a account, because
    // testConnection takes a account context, so the organisation's oldest one
    // stands in — any of them reads the same row.
    const rows = await owner`
      select i.kind,
             (select w.id from account w
               where w.organisation_id = i.organisation_id
               order by w.created_at, w.id
               limit 1) as account_id
        from integration i
       where i.secret_ref is not null`

    for (const row of rows) {
      // An organisation with a credential and no account has nowhere to run
      // the test. Nothing to report, rather than a request with a null tenant.
      if (!row.account_id) continue
      const response = await fetch(`${base}/api/internal/integration-health`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
        body: JSON.stringify({ accountId: row.account_id, kind: row.kind }),
        signal: AbortSignal.timeout(30_000),
      })
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; detail?: string }
      if (!body.ok) {
        // Logged, not thrown. The health state is already red in the database,
        // which is where somebody looks; failing the whole job because one
        // provider is down would stop the others being checked at all.
        console.log(`[integrations] ${row.kind}: ${body.detail ?? `the app answered ${response.status}`}`)
      }
    }
  },
})
