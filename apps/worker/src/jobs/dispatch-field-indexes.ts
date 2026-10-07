import { dropIndexSql } from '@rawr/db'
import { z } from 'zod'
import { boss } from '../boss.ts'
import { owner } from '../db.ts'
import { defineJob } from './registry.ts'

/** How many times a build may be taken before it is called failed. */
const MAX_ATTEMPTS = 3

/** The request that promotes a field only writes a pending row. This claims those
 *  rows and turns them into jobs, so the web app never needs a queue client or an
 *  owner connection, and there is exactly one mechanism rather than a write plus a
 *  send that can disagree.
 *
 *  It carries no account id because it is the one job that scans across tenants,
 *  and it only ever reads ids. */
export const dispatchFieldIndexes = defineJob({
  name: 'field-index.dispatch',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 30,
  handle: async () => {
    // Claiming and reading in one statement is what stops two dispatch runs from
    // queueing the same index twice. A row in 'building' for fifteen minutes since
    // it was last taken belongs to a worker that died, so it is taken again, but
    // only MAX_ATTEMPTS times: past that it is failed with a reason rather than
    // rebuilt for ever.
    const claimed = await owner`
      with claimable as (
        select fi.id, fi.attempts
          from field_index fi
         where fi.state = 'pending'
            or (fi.state = 'building'
                and coalesce(fi.claimed_at, fi.created_at) < now() - interval '15 minutes')
         order by fi.created_at
         limit 100
         for update skip locked
      ), spent as (
        update field_index fi
           set state = 'failed',
               last_error = ${`The build was started ${MAX_ATTEMPTS} times and never finished.`}
          from claimable c
         where fi.id = c.id and c.attempts >= ${MAX_ATTEMPTS}
        returning fi.id
      )
      update field_index fi
         set state = 'building', last_error = null, claimed_at = now(), attempts = fi.attempts + 1
        from claimable c
       where fi.id = c.id and c.attempts < ${MAX_ATTEMPTS}
      returning fi.id, fi.account_id, fi.field_id`

    if (claimed.length > 0) console.log(`[field-index.dispatch] queueing ${claimed.length} index build(s).`)

    for (const row of claimed) {
      await boss().send('field-index.create', {
        accountId: row.account_id,
        fieldIndexId: row.id,
        fieldId: row.field_id,
      })
    }

    // An index nothing records any more: its field was deleted or purged, its object
    // dropped, or its account removed. `left(.., 63)` is how Postgres folds a name
    // longer than it allows, so a name on record still finds its folded index.
    const orphans = await owner`
      select i.indexname
        from pg_indexes i
       where i.schemaname = 'public' and i.indexname like 'hot\\_%'
         and not exists (
           select 1 from field_index fi where left(fi.pg_index_name, 63) = i.indexname)`
    for (const { indexname } of orphans) {
      await owner.unsafe(dropIndexSql(indexname as string))
      console.log(`[field-index.dispatch] dropped ${indexname}, which no field uses.`)
    }
  },
})
