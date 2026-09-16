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

/** A call into the app, for the work that needs what only the app has: the
 *  registry, the dedupe rules, and the credentials for storage.
 *
 *  Tried twice when the connection itself fails, because of what these calls are:
 *  this process is long-lived and talks to one host, so fetch keeps the socket
 *  open between them, and the app closes an idle one long before the next chunk
 *  is ready. Writing to that socket fails, and a POST is not replayed for us --
 *  so every few chunks died with "fetch failed" and the run crawled along at
 *  whatever the minute's dispatch could revive.
 *
 *  Only a connection failure is retried. An answer, even a bad one, is the app's
 *  and belongs to the caller; a chunk that timed out is still running there and
 *  must not be started again underneath itself. */
const ask = async (path: string, body: unknown, timeoutMs = 180_000): Promise<unknown> => {
  const send = () =>
    fetch(`${APP_BASE}/api/internal/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })

  let response: Response
  try {
    response = await send()
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'TimeoutError') throw cause
    response = await send()
  }

  const answer = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) throw new Error(answer.error ?? `The app answered ${response.status} for ${path}.`)
  return answer
}

const dispatch = defineJob({
  name: 'import.dispatch',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 60,
  handle: async () => {
    // An upload nobody came back to. A day, not an hour: the parts that did land
    // are resumable now, so a closed tab is something to keep rather than to
    // clean up. Past that the file goes, which the app has to do -- the parts are
    // in storage, and an incomplete multipart upload is billed until it is
    // abandoned explicitly.
    const abandoned = await owner<{ id: string; account_id: string }[]>`
      select id, account_id from import_run
       where state = 'uploading' and updated_at < now() - interval '24 hours'
       limit 50`
    for (const run of abandoned) {
      await ask('import-discard', { accountId: run.account_id, runId: run.id }).catch((cause) => {
        console.error(`[import] could not discard ${run.id}: ${cause}`)
      })
    }
    if (abandoned.length > 0) console.log(`[import] ${abandoned.length} abandoned upload(s) discarded`)

    // A file in storage that the app was reading when it stopped. Reading is
    // resumable, so this only ever costs the rest of the file.
    const reading = await owner<{ id: string; account_id: string; slug: string }[]>`
      select r.id, r.account_id, a.slug
        from import_run r
        join account a on a.id = r.account_id
       where r.state = 'parsing'
         ${SKIPS_FIXTURES ? owner`and a.google_hosted_domain not like '%.test'` : owner``}`
    for (const row of reading) {
      await boss().send('import.parse', { accountId: row.account_id, runId: row.id }, { singletonKey: String(row.id) })
    }
    if (reading.length > 0) console.log(`[import] ${reading.length} reading: ${bySlug(reading)}`)

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
    // The timeout is comfortably past the app's own chunk budget, which is what
    // decides how long a chunk takes. Cut too fine, every chunk of a slow file
    // was abandoned here while the app went on writing it, and the run advanced
    // only as fast as the minute's dispatch could revive it.
    const body = (await ask('import-chunk', { accountId, runId })) as {
      done?: boolean
      processed?: number
      total?: number
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

/** Reading an uploaded file into rows, in the app, because the registry and the
 *  header naming live there.
 *
 *  Normally nothing reaches this queue: the app starts reading the moment the last
 *  part lands, and the run is in the mapper before the next dispatch comes round.
 *  This is what picks a file up when that attempt died with the process. */
const parse = defineJob({
  name: 'import.parse',
  schema: z.object({ accountId: z.uuid(), runId: z.uuid() }),
  retryLimit: 3,
  retryDelaySeconds: 60,
  handle: async ({ accountId, runId }) => {
    const body = await ask('import-parse', { accountId, runId })
    console.log(`[import] ${runId}: read ${(body as { rows?: number }).rows ?? 0} rows`)
  },
})

export const importJobs = [dispatch, parse, run]
export const dispatchImports = dispatch
