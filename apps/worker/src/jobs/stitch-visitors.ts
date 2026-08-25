import {
  backfillVisitor,
  markAliasResolved,
  refreshContactActivity,
  type WorkspaceContext,
} from '@rawr/db'
import { z } from 'zod'
import { boss } from '../boss.ts'
import { owner } from '../db.ts'
import { basePayload, defineJob } from './registry.ts'

/** F4 §3, T2. The back-fill that turns a month of anonymous browsing into a new
 *  contact's timeline.
 *
 *  Two jobs, matching the field-index pair. The web app writes one visitor_alias
 *  row inside the transaction that created the contact and stops; the dispatcher
 *  claims those rows and turns them into work; the worker does the chunked update.
 *  A form response never waits on a visitor with 20,000 page views. */

/** The context a job acts with. 'job' rather than 'public': the actor in the audit
 *  log has to read as what it is, and marketing's ceiling is what a back-fill
 *  needs — it writes contacts' activity and touches nothing else. */
const jobContext = (workspaceId: string): WorkspaceContext => ({
  workspaceId,
  actorId: null,
  actorKind: 'job',
  role: 'marketing',
})

export const dispatchStitches = defineJob({
  name: 'activity.stitch.dispatch',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 30,
  handle: async () => {
    // Claim-and-read in one statement, so two dispatch runs cannot queue the same
    // alias twice. Unlike field_index there is no 'building' state to reclaim: the
    // back-fill is idempotent, so a worker that dies leaves the row unresolved and
    // the next run picks it up.
    const claimed = await owner`
      select id, workspace_id, visitor_id, contact_id
        from visitor_alias
       where resolved_at is null
       order by created_at
       limit 200`

    if (claimed.length === 0) return
    console.log(`[activity.stitch.dispatch] queueing ${claimed.length} back-fill(s).`)

    for (const row of claimed) {
      await boss().send('activity.stitch', {
        workspaceId: row.workspace_id,
        aliasId: row.id,
        visitorId: row.visitor_id,
        contactId: row.contact_id,
      })
    }
  },
})

const payload = basePayload.extend({
  aliasId: z.uuid(),
  visitorId: z.string().min(1),
  contactId: z.uuid(),
})

/** Chunked and idempotent. Only rows whose contact_id is null are ever touched, so
 *  a retry after a crash moves what is left and nothing twice.
 *
 *  Bounded rather than unbounded: a visitor with a million rows finishes over
 *  several runs instead of holding one worker slot for an hour. The alias stays
 *  unresolved until it is genuinely done, and the dispatcher requeues it. */
const MAX_PASSES = 40

export const stitchVisitor = defineJob({
  name: 'activity.stitch',
  schema: payload,
  retryLimit: 5,
  retryDelaySeconds: 60,
  handle: async ({ workspaceId, aliasId, visitorId, contactId }) => {
    const ctx = jobContext(workspaceId)

    let moved = 0
    let passes = 0
    let done = false

    try {
      while (passes < MAX_PASSES) {
        const result = await backfillVisitor(ctx, { visitorId, contactId })
        moved += result.pageViews + result.events
        passes += 1
        if (result.done) {
          done = true
          break
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await markAliasResolved(ctx, aliasId, message)
      throw cause
    }

    // Recomputed rather than incremented, so the panel is right regardless of how
    // many passes it took or which of them was retried.
    await refreshContactActivity(ctx, contactId)

    if (done) await markAliasResolved(ctx, aliasId)
    else console.log(`[activity.stitch] ${visitorId} has more to move; leaving it queued.`)

    if (moved > 0) console.log(`[activity.stitch] attributed ${moved} row(s) to ${contactId}.`)
  },
})
