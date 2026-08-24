import { z } from 'zod'
import { boss } from '../boss.ts'
import { owner } from '../db.ts'
import { defineJob } from './registry.ts'

/** The request that promotes a field only writes a pending row. This claims those
 *  rows and turns them into jobs, so the web app never needs a queue client or an
 *  owner connection, and there is exactly one mechanism rather than a write plus a
 *  send that can disagree.
 *
 *  It carries no workspace id because it is the one job that scans across tenants,
 *  and it only ever reads ids. */
export const dispatchFieldIndexes = defineJob({
  name: 'field-index.dispatch',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 30,
  handle: async () => {
    // Claiming and reading in one statement is what stops two dispatch runs from
    // queueing the same index twice. A row stuck in 'building' past fifteen minutes
    // belongs to a worker that died, so it is reclaimed.
    const claimed = await owner`
      with claimable as (
        select fi.id
          from field_index fi
         where fi.state = 'pending'
            or (fi.state = 'building' and fi.created_at < now() - interval '15 minutes')
         order by fi.created_at
         limit 100
         for update skip locked
      ), claimed as (
        update field_index fi
           set state = 'building', last_error = null
          from claimable c
         where fi.id = c.id
        returning fi.id, fi.workspace_id, fi.field_id
      )
      select claimed.id, claimed.workspace_id,
             f.key as field_key, o.key as object_key
        from claimed
        join field_def f on f.id = claimed.field_id
        join object_def o on o.id = f.object_id`

    if (claimed.length === 0) return
    console.log(`[field-index.dispatch] queueing ${claimed.length} index build(s).`)

    for (const row of claimed) {
      await boss().send('field-index.create', {
        workspaceId: row.workspace_id,
        fieldIndexId: row.id,
        objectKey: row.object_key,
        fieldKey: row.field_key,
      })
    }
  },
})
