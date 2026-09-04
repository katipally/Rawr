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
    // A plain read, and the de-duplication happens on the queue instead. The
    // alias row cannot carry the claim: it stays unresolved until the back-fill
    // genuinely finishes, which is what lets a bounded run be picked up again.
    // Field_index can claim in SQL because it has a 'building' state to claim into.
    const claimed = await owner`
      select id, workspace_id, visitor_id, contact_id
        from visitor_alias
       where resolved_at is null
       order by created_at
       limit 200`

    if (claimed.length === 0) return
    console.log(`[activity.stitch.dispatch] queueing ${claimed.length} back-fill(s).`)

    for (const row of claimed) {
      await boss().send(
        'activity.stitch',
        {
          workspaceId: row.workspace_id,
          aliasId: row.id,
          visitorId: row.visitor_id,
          contactId: row.contact_id,
        },
        // This dispatcher runs every minute and a back-fill is bounded by passes
        // rather than by the clock, so a visitor with a long history was queued
        // again on every tick while the first attempt was still running. One
        // outstanding job per alias is all that is ever useful.
        { singletonKey: row.id as string },
      )
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

    while (passes < MAX_PASSES) {
      const result = await backfillVisitor(ctx, { visitorId, contactId })
      moved += result.pageViews + result.events
      passes += 1
      if (result.done) {
        done = true
        break
      }
    }

    // Recomputed rather than incremented, so the panel is right regardless of how
    // many passes it took or which of them was retried.
    await refreshContactActivity(ctx, contactId)

    // Only on the way out of a clean pass. Resolving on a failure retired the
    // alias on the first transient error, and the four retries that followed had
    // nothing left to finish: the contact kept a half-moved timeline and nothing
    // said so. A throw above leaves it claimable and the dispatcher re-claims it.
    if (done) await markAliasResolved(ctx, aliasId)
    else console.log(`[activity.stitch] ${visitorId} has more to move; leaving it queued.`)

    if (moved > 0) console.log(`[activity.stitch] attributed ${moved} row(s) to ${contactId}.`)
  },
})
