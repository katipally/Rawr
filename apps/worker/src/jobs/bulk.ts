import { z } from 'zod'
import { boss } from '../boss.ts'
import { owner } from '../db.ts'
import { APP_BASE, INTERNAL_SECRET } from '../env.ts'
import { bySlug, defineJob } from './registry.ts'

/** A bulk bar action that outlives the browser tab.
 *
 *  The same shape as an import, for the same reason: the work belongs in the app,
 *  where the registry, the audit path and the timeline live, so the worker's whole
 *  job is to keep asking for the next chunk until the run says it is done. The
 *  minute's dispatch is the backstop that picks a run up again after a deploy or a
 *  sleep; inside a run the next chunk is queued the moment the last one answers. */

const dispatch = defineJob({
  name: 'bulk.dispatch',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 60,
  handle: async () => {
    const rows = await owner<{ id: string; account_id: string; slug: string }[]>`
      select o.id, o.account_id, a.slug
        from bulk_operation o
        join account a on a.id = o.account_id
       where o.state = 'running'
         -- The verify suites drive their own runs against this same database, one
         -- chunk at a time, and would race a worker that picked those runs up.
         and a.google_hosted_domain not like '%.test'`

    for (const row of rows) {
      // One chunk in flight per operation. Without it the tick that lands while a
      // chunk is still writing would hand the same slice to two workers.
      await boss().send(
        'bulk.run',
        { accountId: row.account_id, operationId: row.id },
        { singletonKey: String(row.id) },
      )
    }

    if (rows.length > 0) console.log(`[bulk] ${rows.length} running: ${bySlug(rows)}`)
  },
})

const run = defineJob({
  name: 'bulk.run',
  schema: z.object({ accountId: z.uuid(), operationId: z.uuid() }),
  retryLimit: 3,
  retryDelaySeconds: 120,
  handle: async ({ accountId, operationId }) => {
    const response = await fetch(`${APP_BASE}/api/internal/bulk-chunk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
      body: JSON.stringify({ accountId, operationId }),
      signal: AbortSignal.timeout(120_000),
    })

    const body = (await response.json().catch(() => ({}))) as {
      error?: string
      done?: boolean
      processed?: number
      total?: number
    }

    if (!response.ok) {
      throw new Error(body.error ?? `The app answered ${response.status} for bulk action ${operationId}.`)
    }

    console.log(`[bulk] ${operationId}: ${body.processed ?? 0} of ${body.total ?? 0}`)

    if (body.done === false) {
      await boss().send('bulk.run', { accountId, operationId }, { singletonKey: operationId })
    }
  },
})

export const bulkJobs = [dispatch, run]
export const dispatchBulk = dispatch
