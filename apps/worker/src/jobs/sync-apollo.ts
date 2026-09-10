import { z } from 'zod'
import { owner } from '../db.ts'
import { APP_BASE, INTERNAL_SECRET } from '../env.ts'
import { defineJob } from './registry.ts'

/** F6 §3's read-back on a schedule: sequence steps, replies and failures from
 *  Apollo onto the contact timeline, for every account that has Apollo
 *  connected. The call lives in the app next to the credentials; the worker owns
 *  only the clock. An account that fails is collected and the next one still
 *  runs; the job throws once at the end, naming them, so one broken key is
 *  visible without costing every other tenant its sync. */
export const syncApollo = defineJob({
  name: 'apollo.sync',
  schema: z.object({}),
  retryLimit: 2,
  retryDelaySeconds: 600,
  handle: async () => {
    const rows = await owner`
      select i.account_id, a.slug
        from integration i
        join account a on a.id = i.account_id
       where i.kind = 'apollo' and i.secret_ref is not null and i.state <> 'revoked'`

    const broken: string[] = []

    for (const row of rows) {
      try {
        const response = await fetch(`${APP_BASE}/api/internal/apollo-sync`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
          body: JSON.stringify({ accountId: row.account_id }),
          signal: AbortSignal.timeout(300_000),
        })
        const body = (await response.json().catch(() => ({}))) as {
          error?: string
          contacts?: number
          recorded?: number
          failed?: string[]
        }
        // A non-2xx with no body of its own said nothing at all, which is what
        // produced the empty "[apollo] :" lines in the logs.
        if (!response.ok) {
          broken.push(`${row.slug}: ${body.error ?? `the app answered ${response.status}`}`)
          continue
        }
        if (body.error) {
          broken.push(`${row.slug}: ${body.error}`)
          continue
        }
        console.log(
          `[apollo] ${row.slug}: ${body.contacts ?? 0} contacts, ${body.recorded ?? 0} new events${body.failed?.length ? `, ${body.failed.length} failed` : ''}`,
        )
      } catch (cause) {
        broken.push(`${row.slug}: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }

    if (broken.length > 0) {
      throw new Error(`Apollo could not be read back for ${broken.length} account(s). ${broken.join(' | ')}`)
    }
  },
})
