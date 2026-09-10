import type { JobWithMetadata } from 'pg-boss'
import { startBoss, stopBoss } from './boss.ts'
import { owner, recordDeadLetter } from './db.ts'
import { automationJobs, dispatchAutomations, scanAutomationRules } from './jobs/automations.ts'
import { bulkJobs, dispatchBulk } from './jobs/bulk.ts'
import { checkIntegrations } from './jobs/check-integrations.ts'
import { createFieldIndex } from './jobs/create-field-index.ts'
import { dispatchFieldIndexes } from './jobs/dispatch-field-indexes.ts'
import { dispatchEnrichment, enrichmentJobs } from './jobs/enrichment.ts'
import { evaluateSegments } from './jobs/evaluate-segments.ts'
import { fillFieldRates } from './jobs/fill-rates.ts'
import { dispatchImports, importJobs } from './jobs/imports.ts'
import { notificationReminders, notificationSweep } from './jobs/notification-sweep.ts'
import { rollUpActivity } from './jobs/roll-up-activity.ts'
import { syncApollo } from './jobs/sync-apollo.ts'
import { dispatchMailboxBodies, dispatchMailboxes, mailJobs } from './jobs/sync-mailboxes.ts'
import { dispatchSequences, sequenceJobs, sweepSequenceLeases } from './jobs/sequences.ts'
import { dispatchStitches, stitchVisitor } from './jobs/stitch-visitors.ts'
import { accountIdOf, type Job } from './jobs/registry.ts'
import { cronFor, dayKeyUtc, isOverdue, lastOccurrence, type DailyAt } from './catch-up.ts'

const JOBS: Job[] = [
  createFieldIndex,
  dispatchFieldIndexes,
  dispatchStitches,
  stitchVisitor,
  rollUpActivity,
  notificationSweep,
  notificationReminders,
  evaluateSegments,
  fillFieldRates,
  ...mailJobs,
  ...importJobs,
  ...bulkJobs,
  ...sequenceJobs,
  ...automationJobs,
  ...enrichmentJobs,
  checkIntegrations,
  syncApollo,
]

const boss = await startBoss()

for (const job of JOBS) {
  await boss.createQueue(job.name, {
    retryLimit: job.retryLimit,
    retryDelay: job.retryDelaySeconds,
    retryBackoff: true,
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
        await recordDeadLetter({
          accountId: accountIdOf(message.data),
          jobName: job.name,
          payload: message.data,
          error: `Payload rejected: ${parsed.error}`,
          attempts: message.retryCount,
        })
        return
      }

      try {
        await job.handle(parsed.value)
      } catch (cause) {
        if (message.retryCount >= job.retryLimit) {
          await recordDeadLetter({
            accountId: accountIdOf(parsed.value),
            jobName: job.name,
            payload: message.data,
            error: cause instanceof Error ? cause.message : String(cause),
            attempts: message.retryCount,
          })
        }
        throw cause
      }
    },
  )

  console.log(`[worker] listening on ${job.name}`)
}

// Once a minute: the promotion request writes a pending row, this turns it into work.
await boss.schedule(dispatchFieldIndexes.name, '* * * * *', {})
// Same shape for F4: a form fill writes one visitor_alias row, this turns it into
// a back-fill. A minute is the ceiling on how long a new contact reads as having
// no browsing history.
await boss.schedule(dispatchStitches.name, '* * * * *', {})
// The daily jobs, declared once so the boot-time catch-up below asks about
// the same times the schedule fires at. The roll-up is nightly: retention is
// measured in months, so the hour it runs does not matter, only that it runs off
// the request path. The sweep is early morning. The only notice with no event
// behind it is "this task is overdue", because a task does not become overdue, it
// stops not being, and telling somebody at seven is telling them before they
// start rather than during. The same pass is what bounds the table.
const DAILY: { job: Job; at: DailyAt }[] = [
  { job: rollUpActivity, at: { hourUtc: 3, minuteUtc: 30 } },
  { job: notificationSweep, at: { hourUtc: 7, minuteUtc: 0 } },
  // Before the sweep and after the roll-up, so the numbers a person sees when
  // they open settings in the morning were taken while nothing else was scanning.
  { job: fillFieldRates, at: { hourUtc: 4, minuteUtc: 15 } },
]
for (const daily of DAILY) await boss.schedule(daily.job.name, cronFor(daily.at), {})
// Hourly, which is the bound on how stale a segment's membership can be. A2 asks
// for "on write and on a schedule"; a write recomputes the one segment somebody is
// looking at, and this covers everything else.
// A reminder is set for an instant, so it cannot wait for the nightly sweep. A
// quarter hour is the bound on how late one arrives.
await boss.schedule(notificationReminders.name, '*/15 * * * *', {})
await boss.schedule(evaluateSegments.name, '0 * * * *', {})
// F1 phase B. Every ten minutes: connected mailboxes catch up, and one still
// reading its history queues its own next page immediately rather than waiting.
await boss.schedule(dispatchMailboxes.name, '*/10 * * * *', {})

// Bodies follow the messages a few minutes behind, so a thread opened right after
// a sync shows its snippets now and its full text shortly after.
await boss.schedule(dispatchMailboxBodies.name, '*/5 * * * *', {})

// Every minute: a run somebody started before a deploy or a sleep picks itself
// up again, and a run that finishes its chunk queues the next one itself.
await boss.schedule(dispatchImports.name, '* * * * *', {})

// Every minute, and for the same reason imports are: a bulk action somebody
// started before a deploy picks itself up again, and one that finishes its chunk
// queues the next one itself.
await boss.schedule(dispatchBulk.name, '* * * * *', {})

// Every minute: a step whose delay says "two hours" should not wait until the top
// of the next hour, and the scan is one indexed range over the due queue.
await boss.schedule(dispatchSequences.name, '* * * * *', {})
await boss.schedule(sweepSequenceLeases.name, '*/10 * * * *', {})
// B11. Every minute, for the same reason a sequence step is: a rule that says
// "wait twenty minutes" should not wait until the top of the hour, and the scan
// is one indexed range over the runs that are actually parked.
await boss.schedule(dispatchAutomations.name, '* * * * *', {})
// B11 again, for the two triggers no write announces. Hourly, because both are
// measured in days and the run's per-day uniqueness makes a second sweep in the
// same day a no-op. Ten past, so it does not queue behind the top-of-hour segment
// evaluation.
await boss.schedule(scanAutomationRules.name, '10 * * * *', {})
// F6 §1. Every half hour, so a credential revoked at the provider turns the health
// red within one cycle rather than the next time somebody opens Settings.
await boss.schedule(checkIntegrations.name, '*/30 * * * *', {})
// Every minute, which is the bound on how long a new contact reads as
// unenriched. Sixty records a tick is the ceiling on provider credits a minute.
await boss.schedule(dispatchEnrichment.name, '* * * * *', {})
// F6 §3. Sequence steps, replies and failures read back from Apollo every half
// hour, offset from the health check so the two do not queue behind each other.
await boss.schedule(syncApollo.name, '15,45 * * * *', {})

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
