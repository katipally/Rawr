import type { JobWithMetadata } from 'pg-boss'
import { startBoss, stopBoss } from './boss.ts'
import { owner, recordDeadLetter } from './db.ts'
import { createFieldIndex } from './jobs/create-field-index.ts'
import { dispatchFieldIndexes } from './jobs/dispatch-field-indexes.ts'
import { rollUpActivity } from './jobs/roll-up-activity.ts'
import { dispatchStitches, stitchVisitor } from './jobs/stitch-visitors.ts'
import { workspaceIdOf, type Job } from './jobs/registry.ts'

const JOBS: Job[] = [createFieldIndex, dispatchFieldIndexes, dispatchStitches, stitchVisitor, rollUpActivity]

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
          workspaceId: workspaceIdOf(message.data),
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
            workspaceId: workspaceIdOf(parsed.value),
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
// Nightly. Retention is measured in months, so the hour it runs does not matter;
// that it runs off the request path does.
await boss.schedule(rollUpActivity.name, '30 3 * * *', {})

const shutdown = async (signal: string) => {
  console.log(`[worker] ${signal} received, finishing in-flight work.`)
  await stopBoss()
  await owner.end({ timeout: 5 })
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

console.log('[worker] ready.')
