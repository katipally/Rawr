import { z } from 'zod'
import { boss } from '../boss.ts'
import { owner } from '../db.ts'
import { APP_BASE, INTERNAL_SECRET } from '../env.ts'
import { bySlug, defineJob } from './registry.ts'

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
    const rows = await owner<{ id: string; account_id: string; slug: string }[]>`
      select r.id, r.account_id, a.slug from automation_run r
        join account a on a.id = r.account_id
       where r.state = 'waiting'
         and r.resume_at is not null
         and r.resume_at <= now()
         and (r.lease_until is null or r.lease_until < now())
       order by r.resume_at
       limit ${BATCH}`

    for (const row of rows) {
      await boss().send(
        'automation.resume',
        { accountId: row.account_id, runId: row.id },
        // One in flight per run. Without it a tick landing while the previous
        // resume is still going would queue the same step twice, and the lease
        // would only turn that into a wasted job rather than a duplicate.
        { singletonKey: String(row.id) },
      )
    }

    if (rows.length > 0) console.log(`[automation] ${rows.length} due: ${bySlug(rows)}`)
  },
})

const resume = defineJob({
  name: 'automation.resume',
  schema: z.object({ accountId: z.uuid(), runId: z.uuid() }),
  retryLimit: 3,
  retryDelaySeconds: 300,
  handle: async ({ accountId, runId }) => {
    const response = await fetch(`${APP_BASE}/api/internal/automation-step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
      body: JSON.stringify({ accountId, runId }),
      signal: AbortSignal.timeout(90_000),
    })

    const body = (await response.json()) as { error?: string; resumed?: boolean; reason?: string }
    if (!response.ok) {
      throw new Error(body.error ?? `The app answered ${response.status} for run ${runId}.`)
    }
    if (!body.resumed && body.reason) console.log(`[automation] ${runId}: ${body.reason}`)
  },
})

/** The rules nothing announces.
 *
 *  Four of the six triggers are events Rawr emits on a write, and the app fires
 *  those inside the request that caused them. The other two are absences: a date
 *  arriving, and a record that has gone quiet. Nobody writes an absence, so once
 *  an hour every account holding an armed one is swept.
 *
 *  Hourly rather than by the minute because both are measured in days, and the
 *  per-day uniqueness on the run means a sweep that lands twelve times before
 *  midnight still fires each rule once. Split across two jobs for the same reason
 *  the dispatch above is: one tenant with forty thousand contacts must not hold
 *  up everybody else's sweep.
 *
 *  The account list comes from the rules themselves, so an account with nothing
 *  armed is never asked. */
const scan = defineJob({
  name: 'automation.scan',
  schema: z.object({}),
  retryLimit: 2,
  retryDelaySeconds: 300,
  handle: async () => {
    const rows = await owner<{ account_id: string; slug: string }[]>`
      select distinct a.account_id, ac.slug from automation a
        join account ac on ac.id = a.account_id
       where a.is_active and a.trigger in ('date_reached', 'no_activity')`

    for (const row of rows) {
      await boss().send('automation.scan.account', { accountId: row.account_id }, { singletonKey: row.account_id })
    }

    if (rows.length > 0) console.log(`[automation] scanning ${bySlug(rows)}`)
  },
})

const scanAccount = defineJob({
  name: 'automation.scan.account',
  schema: z.object({ accountId: z.uuid() }),
  retryLimit: 2,
  retryDelaySeconds: 600,
  handle: async ({ accountId }) => {
    const response = await fetch(`${APP_BASE}/api/internal/automation-step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawr-internal': INTERNAL_SECRET },
      body: JSON.stringify({ accountId }),
      signal: AbortSignal.timeout(300_000),
    })

    const body = (await response.json()) as { error?: string; scanned?: number; fired?: number }
    if (!response.ok) {
      throw new Error(body.error ?? `The app answered ${response.status} scanning ${accountId}.`)
    }
    if (body.fired) console.log(`[automation] ${body.scanned} scanned rule(s) fired ${body.fired} time(s)`)
  },
})

export const automationJobs = [dispatch, resume, scan, scanAccount]
export const dispatchAutomations = dispatch
export const scanAutomationRules = scan
