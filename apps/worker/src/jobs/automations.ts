import { z } from 'zod'
import { boss } from '../boss.ts'
import { owner } from '../db.ts'
import { defineJob } from './registry.ts'

/** The clock behind a rule that waits.
 *
 *  The same split as sequences, for the same reason: the dispatch is one indexed
 *  range scan a minute across every tenant, and the resume is one run, claimed
 *  with a lease so two workers cannot advance it twice. Doing the work inside the
 *  dispatch would let one slow Slack call stall every other tenant's rules.
 *
 *  There is no sweep job here, unlike sequences. A lease a dead process left
 *  behind expires on its own, and the next tick claims the run because expiry is
 *  already part of the claim's condition. */

/** Enough that a busy minute is not left behind, small enough that one tick
 *  cannot flood the queue. */
const BATCH = 500

const dispatch = defineJob({
  name: 'automation.dispatch',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 60,
  handle: async () => {
    const rows = await owner`
      select id, workspace_id from automation_run
       where state = 'waiting'
         and resume_at is not null
         and resume_at <= now()
         and (lease_until is null or lease_until < now())
       order by resume_at
       limit ${BATCH}`

    for (const row of rows) {
      await boss().send(
        'automation.resume',
        { workspaceId: row.workspace_id, runId: row.id },
        // One in flight per run. Without it a tick landing while the previous
        // resume is still going would queue the same step twice, and the lease
        // would only turn that into a wasted job rather than a duplicate.
        { singletonKey: String(row.id) },
      )
    }

    if (rows.length > 0) console.log(`[automation] ${rows.length} due`)
  },
})

const resume = defineJob({
  name: 'automation.resume',
  schema: z.object({ workspaceId: z.uuid(), runId: z.uuid() }),
  retryLimit: 3,
  retryDelaySeconds: 300,
  handle: async ({ workspaceId, runId }) => {
    const base = process.env.RAWR_INTERNAL_URL ?? 'http://localhost:3000'
    const secret = process.env.RAWR_INTERNAL_SECRET ?? ''
    if (!secret) {
      throw new Error(
        'RAWR_INTERNAL_SECRET is not set, so the worker cannot ask the app to run a step. Set the same value on both.',
      )
    }

    const response = await fetch(`${base}/api/internal/automation-step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': secret },
      body: JSON.stringify({ workspaceId, runId }),
      signal: AbortSignal.timeout(90_000),
    })

    const body = (await response.json()) as { error?: string; resumed?: boolean; reason?: string }
    if (!response.ok) {
      throw new Error(body.error ?? `The app answered ${response.status} for run ${runId}.`)
    }
    if (!body.resumed && body.reason) console.log(`[automation] ${runId}: ${body.reason}`)
  },
})

export const automationJobs = [dispatch, resume]
export const dispatchAutomations = dispatch
