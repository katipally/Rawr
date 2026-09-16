import { z } from 'zod'
import { boss } from '../boss.ts'
import { owner } from '../db.ts'
import { APP_BASE, INTERNAL_SECRET, SKIPS_FIXTURES } from '../env.ts'
import { bySlug, defineJob } from './registry.ts'

/** An import that outlives the browser tab.
 *
 *  The rows are written and matched in the app, where the registry and the
 *  dedupe rules live, so the worker's whole job is to keep asking for the next
 *  chunk until the run says it is done. A minute's dispatch is the backstop that
 *  picks a run up again after a deploy or a sleep; inside a run the next chunk is
 *  queued the moment the last one answers, so 88,000 rows take minutes rather
 *  than a chunk a minute. */

const dispatch = defineJob({
  name: 'import.dispatch',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 60,
  handle: async () => {
    // An upload whose tab closed half way sends nothing more, and its rows would
    // sit in import_row for good. An hour without a batch is a tab that is gone:
    // a live one sends a batch every few seconds.
    const abandoned = await owner<{ id: string }[]>`
      update import_run
         set state = 'failed', finished_at = now(), updated_at = now(),
             errors = coalesce(errors, '[]'::jsonb)
               || ${JSON.stringify([{ row: 0, reason: 'The upload stopped before the whole file arrived. Upload it again.' }])}::jsonb
       where state = 'uploading' and updated_at < now() - interval '1 hour'
       returning id`
    if (abandoned.length > 0) {
      await owner`delete from import_row where run_id in ${owner(abandoned.map((run) => run.id))}`
      console.log(`[import] ${abandoned.length} abandoned upload(s) closed`)
    }

    const rows = await owner<{ id: string; account_id: string; slug: string }[]>`
      select r.id, r.account_id, a.slug
        from import_run r
        join account a on a.id = r.account_id
       where r.state = 'running'
         ${SKIPS_FIXTURES ? owner`and a.google_hosted_domain not like '%.test'` : owner``}`

    for (const row of rows) {
      // What keeps two workers off the same position range is that the queue has
      // one worker and it awaits each handler, not this key: a queue created
      // without a policy is `standard`, and pg-boss enforces singletonKey only on
      // the policies that carry a unique index for it. Kept because it is the
      // right key the day this queue is given one, and it costs nothing today.
      await boss().send(
        'import.run',
        { accountId: row.account_id, runId: row.id },
        { singletonKey: String(row.id) },
      )
    }

    if (rows.length > 0) console.log(`[import] ${rows.length} running: ${bySlug(rows)}`)
  },
})

const run = defineJob({
  name: 'import.run',
  schema: z.object({ accountId: z.uuid(), runId: z.uuid() }),
  retryLimit: 3,
  retryDelaySeconds: 120,
  handle: async ({ accountId, runId }) => {
    const response = await fetch(`${APP_BASE}/api/internal/import-chunk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
      body: JSON.stringify({ accountId, runId }),
      // Comfortably past the app's own chunk budget, which is what decides how
      // long a chunk takes. Cut too fine, every chunk of a slow file was abandoned
      // here while the app went on writing it, and the run advanced only as fast
      // as the minute's dispatch could revive it.
      signal: AbortSignal.timeout(180_000),
    })

    const body = (await response.json().catch(() => ({}))) as {
      error?: string
      done?: boolean
      processed?: number
      total?: number
    }

    if (!response.ok) {
      throw new Error(body.error ?? `The app answered ${response.status} for import ${runId}.`)
    }

    console.log(`[import] ${runId}: ${body.processed ?? 0} of ${body.total ?? 0}`)

    // Straight back on the queue while there is more file, for the same reason
    // the mailbox back-fill does it: waiting for the next tick would stretch a
    // migration over hours.
    if (body.done === false) {
      await boss().send('import.run', { accountId, runId }, { singletonKey: runId })
    }
  },
})

export const importJobs = [dispatch, run]
export const dispatchImports = dispatch
