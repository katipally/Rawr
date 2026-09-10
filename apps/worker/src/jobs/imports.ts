import { z } from 'zod'
import { boss } from '../boss.ts'
import { owner } from '../db.ts'
import { APP_BASE, INTERNAL_SECRET } from '../env.ts'
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
    const rows = await owner<{ id: string; account_id: string; slug: string }[]>`
      select r.id, r.account_id, a.slug
        from import_run r
        join account a on a.id = r.account_id
       where r.state = 'running'`

    for (const row of rows) {
      // One chunk in flight per run. Without it the tick that lands while a chunk
      // is still writing would hand the same position range to two workers.
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
      signal: AbortSignal.timeout(120_000),
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
