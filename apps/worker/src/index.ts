import type { JobWithMetadata } from 'pg-boss'
import { startBoss, stopBoss } from './boss.ts'
import { SCHEDULE_OVERRIDES } from './env.ts'
import { owner, recordJobFailure } from './db.ts'
import { ensureQueue } from './queue-policy.ts'
import { automationJobs, dispatchAutomations, scanAutomationRules } from './jobs/automations.ts'
import { bookingReminderJobs, dispatchBookingReminders } from './jobs/booking-reminders.ts'
import { bulkJobs, dispatchBulk } from './jobs/bulk.ts'
import { checkIntegrations } from './jobs/check-integrations.ts'
import { createFieldIndex } from './jobs/create-field-index.ts'
import { scoreDeals } from './jobs/deal-score.ts'
import { dispatchFieldIndexes } from './jobs/dispatch-field-indexes.ts'
import { dispatchEnrichment, enrichmentJobs } from './jobs/enrichment.ts'
import { evaluateSegments } from './jobs/evaluate-segments.ts'
import { fillFieldRates } from './jobs/fill-rates.ts'
import { dispatchImports, importJobs } from './jobs/imports.ts'
import { notificationOverdue, notificationReminders, notificationSweep } from './jobs/notification-sweep.ts'
import { rollUpActivity } from './jobs/roll-up-activity.ts'
import { syncApollo } from './jobs/sync-apollo.ts'
import { dispatchMailboxBodies, dispatchMailboxes, mailJobs } from './jobs/sync-mailboxes.ts'
import { dispatchSequences, sequenceJobs, sweepSequenceLeases } from './jobs/sequences.ts'
import { dispatchStitches, stitchVisitor } from './jobs/stitch-visitors.ts'
import type { Job } from './jobs/registry.ts'
import { cronFor, dayKeyUtc, isOverdue, lastOccurrence, type DailyAt } from './catch-up.ts'

const JOBS: Job[] = [
  createFieldIndex,
  dispatchFieldIndexes,
  dispatchStitches,
  stitchVisitor,
  rollUpActivity,
  notificationSweep,
  notificationOverdue,
  notificationReminders,
  evaluateSegments,
  fillFieldRates,
  scoreDeals,
  ...mailJobs,
  ...importJobs,
  ...bulkJobs,
  ...bookingReminderJobs,
  ...sequenceJobs,
  ...automationJobs,
  ...enrichmentJobs,
  checkIntegrations,
  syncApollo,
]

const boss = await startBoss()

// Same grant as bootstrap.sql, which only lands when the pgboss schema already
// existed at migrate time. Read only, on job_common alone: the Failed Jobs page
// reads the dispatcher's last finished job and the waiting count from it.
await owner`grant usage on schema pgboss to rawr_app`
await owner`grant select on pgboss.job_common to rawr_app`

for (const job of JOBS) {
  await ensureQueue(boss, owner, job.name, {
    policy: job.policy ?? 'standard',
    retryLimit: job.retryLimit,
    retryDelay: job.retryDelaySeconds,
  })

  // includeMetadata is what exposes retryCount, which is how the runner knows an
  // attempt was the last one and the failure belongs in dead_letter.
  await boss.work(
    job.name,
    { batchSize: 1, includeMetadata: true },
    async (batch: JobWithMetadata<unknown>[]) => {
      const message = batch[0]
      if (!message) return

      const parsed = job.parse(message.data)
      if (!parsed.ok) {
        // A malformed payload will never succeed, so it goes straight to the dead
        // letter table instead of burning every retry first.
        await recordJobFailure(job, message.data, new Error(`Payload rejected: ${parsed.error}`), message.retryCount)
        return
      }

      try {
        await job.handle(parsed.value)
      } catch (cause) {
        if (message.retryCount >= job.retryLimit) await recordJobFailure(job, message.data, cause, message.retryCount)
        throw cause
      }
    },
  )

  console.log(`[worker] listening on ${job.name}`)
}

// The cron a job runs on, unless RAWR_WORKER_SCHEDULES names another for it. A name
// that matches no job is a typo, and refusing it beats a job that never moves.
const unknown = Object.keys(SCHEDULE_OVERRIDES).filter((name) => !JOBS.some((job) => job.name === name))
if (unknown.length > 0) throw new Error(`RAWR_WORKER_SCHEDULES names no job called ${unknown.join(', ')}.`)
const every = (job: Job, cron: string) => boss.schedule(job.name, SCHEDULE_OVERRIDES[job.name] ?? cron, {})

// Once a minute: the promotion request writes a pending row, this turns it into work.
await every(dispatchFieldIndexes, '* * * * *')
// Same shape for F4: a form fill writes one visitor_alias row, this turns it into
// a back-fill. A minute is the ceiling on how long a new contact reads as having
// no browsing history.
await every(dispatchStitches, '* * * * *')
// The daily jobs, declared once so the boot-time catch-up below asks about
// the same times the schedule fires at. The roll-up is nightly: retention is
// measured in months, so the hour it runs does not matter, only that it runs off
// the request path. The sweep is early morning and is what bounds the notification
// table. Neither is tied to an account's day, so both stay on UTC; the one notice
// that is, "this task is overdue", runs hourly below.
const DAILY: { job: Job; at: DailyAt }[] = [
  { job: rollUpActivity, at: { hourUtc: 3, minuteUtc: 30 } },
  { job: notificationSweep, at: { hourUtc: 7, minuteUtc: 0 } },
  // Before the sweep and after the roll-up, so the numbers a person sees when
  // they open settings in the morning were taken while nothing else was scanning.
  { job: fillFieldRates, at: { hourUtc: 4, minuteUtc: 15 } },
  // After the fill rates and before the sweep, for the same reason: the board a
  // rep opens in the morning was scored while nothing else was scanning.
  { job: scoreDeals, at: { hourUtc: 4, minuteUtc: 45 } },
]
for (const daily of DAILY) await boss.schedule(daily.job.name, cronFor(daily.at), {})
// Hourly, which is the bound on how stale a segment's membership can be. A2 asks
// for "on write and on a schedule"; a write recomputes the one segment somebody is
// looking at, and this covers everything else.
// A reminder is set for an instant, so it cannot wait for the nightly sweep. A
// quarter hour is the bound on how late one arrives.
await every(notificationReminders, '*/15 * * * *')
// Hourly because each account's morning falls at a different UTC hour.
await every(notificationOverdue, '0 * * * *')
await every(evaluateSegments, '0 * * * *')
// F1 phase B. Every ten minutes: connected mailboxes catch up, and one still
// reading its history queues its own next page immediately rather than waiting.
await every(dispatchMailboxes, '*/10 * * * *')

// Bodies follow the messages a few minutes behind, so a thread opened right after
// a sync shows its snippets now and its full text shortly after.
await every(dispatchMailboxBodies, '*/5 * * * *')

// Every minute: a run somebody started before a deploy or a sleep picks itself
// up again, and a run that finishes its chunk queues the next one itself.
await every(dispatchImports, '* * * * *')

// Every minute, and for the same reason imports are: a bulk action somebody
// started before a deploy picks itself up again, and one that finishes its chunk
// queues the next one itself.
await every(dispatchBulk, '* * * * *')

// Every five minutes. A reminder is due at an instant, and five minutes is the
// bound on how late one arrives; finer than that only costs a scan of the same
// upcoming meetings for nothing.
await every(dispatchBookingReminders, '*/5 * * * *')

// Every minute: a step whose delay says "two hours" should not wait until the top
// of the next hour, and the scan is one indexed range over the due queue.
await every(dispatchSequences, '* * * * *')
await every(sweepSequenceLeases, '*/10 * * * *')
// B11. Every minute, for the same reason a sequence step is: a rule that says
// "wait twenty minutes" should not wait until the top of the hour, and the scan
// is one indexed range over the runs that are actually parked.
await every(dispatchAutomations, '* * * * *')
// B11 again, for the two triggers no write announces. Hourly, because both are
// measured in days and the run's per-day uniqueness makes a second sweep in the
// same day a no-op. Ten past, so it does not queue behind the top-of-hour segment
// evaluation.
await every(scanAutomationRules, '10 * * * *')
// F6 §1. Every half hour, so a credential revoked at the provider turns the health
// red within one cycle rather than the next time somebody opens Settings.
await every(checkIntegrations, '*/30 * * * *')
// Every minute, which is the bound on how long a new contact reads as
// unenriched. Sixty records a tick is the ceiling on provider credits a minute.
await every(dispatchEnrichment, '* * * * *')
// F6 §3. Sequence steps, replies and failures read back from Apollo every half
// hour, offset from the health check so the two do not queue behind each other.
await every(syncApollo, '15,45 * * * *')

// The free tier sleeps, and a schedule nobody was awake to evaluate is a night
// with no roll-up and no overdue-task notices. Each daily job is asked whether it
// has completed since the time it was due; the day in the key is what stops two
// restarts in one morning from running it twice.
for (const daily of DAILY) {
  const [last] = await owner`
    select max(completed_on) as at from pgboss.job
     where name = ${daily.job.name} and state = 'completed'`
  const occurrence = lastOccurrence(new Date(), daily.at)
  if (!isOverdue(last?.at ? new Date(last.at as string) : null, occurrence)) continue
  await boss.send(daily.job.name, {}, { singletonKey: `${daily.job.name}:${dayKeyUtc(occurrence)}` })
  console.log(`[worker] ${daily.job.name} was due at ${occurrence.toISOString()} and had not run; queued.`)
}

const shutdown = async (signal: string) => {
  console.log(`[worker] ${signal} received, finishing in-flight work.`)
  await stopBoss()
  await owner.end({ timeout: 5 })
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

console.log('[worker] ready.')
