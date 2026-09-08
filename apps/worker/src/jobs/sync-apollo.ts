import { z } from 'zod'
import { owner } from '../db.ts'
import { INTERNAL_SECRET } from '../env.ts'
import { defineJob } from './registry.ts'

/** F6 §3's read-back on a schedule: sequence steps, replies and failures from
 *  Apollo onto the contact timeline, for every account that has Apollo
 *  connected. The call lives in the app next to the credentials; the worker owns
 *  only the clock. An account that fails is logged and the next one still runs. */
export const syncApollo = defineJob({
  name: 'apollo.sync',
  schema: z.object({}),
  retryLimit: 2,
  retryDelaySeconds: 600,
  handle: async () => {
    const base = process.env.RAWR_INTERNAL_URL ?? 'http://localhost:3000'

    const rows = await owner`
      select i.account_id
        from integration i
       where i.kind = 'apollo' and i.secret_ref is not null and i.state <> 'revoked'`

    for (const row of rows) {
      const response = await fetch(`${base}/api/internal/apollo-sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
        body: JSON.stringify({ accountId: row.account_id }),
        signal: AbortSignal.timeout(300_000),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string; contacts?: number; recorded?: number; failed?: string[] }
      if (body.error) console.log(`[apollo] ${row.account_id}: ${body.error}`)
      else console.log(`[apollo] ${row.account_id}: ${body.contacts ?? 0} contacts, ${body.recorded ?? 0} new events${body.failed?.length ? `, ${body.failed.length} failed` : ''}`)
    }
  },
})
