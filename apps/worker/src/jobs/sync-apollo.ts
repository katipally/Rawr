import { z } from 'zod'
import { owner } from '../db.ts'
import { defineJob } from './registry.ts'

/** F6 §3's read-back on a schedule: sequence steps, replies and failures from
 *  Apollo onto the contact timeline, for every workspace that has Apollo
 *  connected. The call lives in the app next to the credentials; the worker owns
 *  only the clock. A workspace that fails is logged and the next one still runs. */
export const syncApollo = defineJob({
  name: 'apollo.sync',
  schema: z.object({}),
  retryLimit: 2,
  retryDelaySeconds: 600,
  handle: async () => {
    const base = process.env.RAWR_INTERNAL_URL ?? 'http://localhost:3000'
    const secret = process.env.RAWR_INTERNAL_SECRET ?? ''
    if (!secret) {
      throw new Error(
        'RAWR_INTERNAL_SECRET is not set, so the worker cannot ask the app to sync Apollo. Set the same value on both.',
      )
    }

    const rows = await owner`
      select workspace_id from integration
       where kind = 'apollo' and secret_ref is not null and state <> 'revoked'`

    for (const row of rows) {
      const response = await fetch(`${base}/api/internal/apollo-sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rawr-internal': secret },
        body: JSON.stringify({ workspaceId: row.workspace_id }),
        signal: AbortSignal.timeout(300_000),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string; contacts?: number; recorded?: number; failed?: string[] }
      if (body.error) console.log(`[apollo] ${row.workspace_id}: ${body.error}`)
      else console.log(`[apollo] ${row.workspace_id}: ${body.contacts ?? 0} contacts, ${body.recorded ?? 0} new events${body.failed?.length ? `, ${body.failed.length} failed` : ''}`)
    }
  },
})
