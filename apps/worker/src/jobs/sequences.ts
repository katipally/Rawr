import { z } from 'zod'
import { boss } from '../boss.ts'
import { owner } from '../db.ts'
import { defineJob } from './registry.ts'

/** The clock behind sequences.
 *
 *  Three jobs, and the split matters. The dispatch is one indexed range scan a
 *  minute over every tenant; the run is one enrollment, claimed with a lease so
 *  two workers cannot send the same step; the sweep frees leases a worker died
 *  holding. Putting the send in the dispatch would mean one slow mailbox stalls
 *  every other tenant's outreach. */

/** Enough that a busy minute is not left behind, small enough that one tick
 *  cannot flood the queue. */
const BATCH = 500

const dispatch = defineJob({
  name: 'sequence.dispatch',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 60,
  handle: async () => {
    const rows = await owner`
      select id, workspace_id from sequence_enrollment
       where state = 'active'
         and next_run_at is not null
         and next_run_at <= now()
         and (lease_until is null or lease_until < now())
       order by next_run_at
       limit ${BATCH}`

    for (const row of rows) {
      await boss().send(
        'sequence.run',
        { workspaceId: row.workspace_id, enrollmentId: row.id },
        // One in flight per enrollment. Without this, a tick landing while the
        // previous run is still going would queue the same step twice, and the
        // lease would only turn that into a wasted job rather than a duplicate.
        { singletonKey: String(row.id) },
      )
    }

    if (rows.length > 0) console.log(`[sequence] ${rows.length} due`)
  },
})

const run = defineJob({
  name: 'sequence.run',
  schema: z.object({ workspaceId: z.uuid(), enrollmentId: z.uuid() }),
  retryLimit: 3,
  retryDelaySeconds: 300,
  handle: async ({ workspaceId, enrollmentId }) => {
    const base = process.env.RAWR_INTERNAL_URL ?? 'http://localhost:3000'
    const secret = process.env.RAWR_INTERNAL_SECRET ?? ''
    if (!secret) {
      throw new Error(
        'RAWR_INTERNAL_SECRET is not set, so the worker cannot ask the app to send. Set the same value on both.',
      )
    }

    const response = await fetch(`${base}/api/internal/sequence-step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': secret },
      body: JSON.stringify({ workspaceId, enrollmentId }),
      signal: AbortSignal.timeout(90_000),
    })

    const body = (await response.json()) as {
      error?: string
      ran?: boolean
      kind?: string
      reason?: string
      revoked?: boolean
    }

    if (!response.ok) {
      // A withdrawn grant stops every enrollment on that mailbox and is not
      // something a retry can fix. The app has already recorded it.
      if (body.revoked) {
        console.log(`[sequence] ${enrollmentId}: the mailbox's access was withdrawn.`)
        return
      }
      throw new Error(body.error ?? `The app answered ${response.status} for enrollment ${enrollmentId}.`)
    }

    if (body.ran) console.log(`[sequence] ${enrollmentId}: ${body.kind} step ran.`)
    else if (body.reason) console.log(`[sequence] ${enrollmentId}: ${body.reason}`)
  },
})

const sweep = defineJob({
  name: 'sequence.leases',
  schema: z.object({}),
  retryLimit: 2,
  retryDelaySeconds: 120,
  handle: async () => {
    const rows = await owner`
      update sequence_enrollment set lease_until = null
       where lease_until is not null and lease_until < now()
      returning id`
    if (rows.length > 0) {
      console.log(`[sequence] freed ${rows.length} lease(s) a worker did not finish.`)
    }
  },
})

export const sequenceJobs = [dispatch, run, sweep]
export const dispatchSequences = dispatch
export const sweepSequenceLeases = sweep
