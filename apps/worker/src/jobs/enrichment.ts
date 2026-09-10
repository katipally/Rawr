import { z } from 'zod'
import { boss } from '../boss.ts'
import { owner } from '../db.ts'
import { APP_BASE, INTERNAL_SECRET } from '../env.ts'
import { defineJob } from './registry.ts'

/** The clock behind automatic enrichment.
 *
 *  The data layer writes one enrichment_request row whenever a contact gains an
 *  email or a company a domain, and a person approves the batch on screen. This
 *  turns approved rows into jobs, one per record, so the app never needs a queue
 *  client and a large batch becomes a steady stream rather than one burst.
 *
 *  Two things are never drained: a row nobody has approved, and a row belonging
 *  to an account with no enricher connected. The second waits and runs the
 *  minute a key is pasted, which is the backfill nobody has to ask for. */

/** The most records queued per tick, which is the ceiling on provider spend per
 *  minute. An import beyond it drains over the following minutes. */
const BATCH = 60

const ENRICHER_KINDS = ['apollo', 'lusha', 'clay']

const dispatch = defineJob({
  name: 'enrichment.dispatch',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 30,
  handle: async () => {
    // A request nobody answered or could serve for a month is stale: the record
    // has been edited, merged or deleted since, and a fresh write asks again.
    await owner`delete from enrichment_request where requested_at < now() - interval '30 days'`

    // And a request for a record that is gone is not stale, it is void. Deleting
    // and merging clear their own rows; erasure and anything run by hand do not,
    // and claiming one would spend three retries to learn the record is missing.
    await owner`
      delete from enrichment_request r
       where case r.entity
               when 'contact' then not exists (select 1 from contact c where c.id = r.entity_id and c.deleted_at is null)
               when 'company' then not exists (select 1 from company c where c.id = r.entity_id and c.deleted_at is null)
               else true
             end`

    // Claiming is deleting, in one statement, so two ticks cannot queue the same
    // record twice. A job that then fails retries on its own and lands in
    // dead_letter, where it can be replayed.
    const claimed = await owner`
      with due as (
        select r.account_id, r.entity, r.entity_id
          from enrichment_request r
         where r.approved_at is not null
           and exists (
                 select 1 from integration i
                  where i.account_id = r.account_id
                    and i.kind in ${owner(ENRICHER_KINDS)}
                    and i.state in ('connected', 'degraded'))
         order by r.approved_at
         limit ${BATCH}
         for update skip locked
      )
      delete from enrichment_request r
       using due
       where r.account_id = due.account_id and r.entity = due.entity and r.entity_id = due.entity_id
      returning r.account_id, r.entity, r.entity_id`

    for (const row of claimed) {
      await boss().send(
        'enrichment.run',
        { accountId: row.account_id, entity: row.entity, entityId: row.entity_id },
        { singletonKey: `${row.entity}:${row.entity_id}` },
      )
    }
    if (claimed.length > 0) console.log(`[enrichment] ${claimed.length} queued`)
  },
})

const run = defineJob({
  name: 'enrichment.run',
  schema: z.object({ accountId: z.uuid(), entity: z.enum(['contact', 'company']), entityId: z.uuid() }),
  retryLimit: 3,
  retryDelaySeconds: 300,
  handle: async ({ accountId, entity, entityId }) => {
    const response = await fetch(`${APP_BASE}/api/internal/enrich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
      body: JSON.stringify({ accountId, entity, entityId }),
      signal: AbortSignal.timeout(120_000),
    })
    const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: string; written?: string[] }
    if (!response.ok) throw new Error(body.error ?? `The app answered ${response.status} for ${entity} ${entityId}.`)
    console.log(`[enrichment] ${entity} ${entityId}: ${body.written?.length ?? 0} filled. ${body.detail ?? ''}`.trim())
  },
})

export const enrichmentJobs = [dispatch, run]
export const dispatchEnrichment = dispatch
