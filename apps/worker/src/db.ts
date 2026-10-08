import { notifyFamilyFailure, recordDeadLetter as recordAccountDeadLetter, systemContext } from '@rawr/db'
import postgres from 'postgres'
import { OWNER_URL } from './env.ts'
import { AccountFailures, accountIdOf, type Job } from './jobs/registry.ts'

/** One owner connection for the worker's own bookkeeping: the pg-boss schema, the
 *  dead-letter table, and the single function that emits DDL. Nothing here reads
 *  tenant records; that goes through @rawr/db so row level security applies. */
export const owner = postgres(OWNER_URL, { max: 2, onnotice: () => {} })

export const recordDeadLetter = async (input: {
  accountId: string
  jobName: string
  payload: unknown
  error: string
  /** Null for a failure that was never a queued job, so the failed-jobs table can
   *  say "not queued" rather than claim it was tried nought times. */
  attempts: number | null
}): Promise<void> => {
  // An account deleted while its jobs were still in flight would fail the foreign
  // key, and that error would replace the one being recorded. The failure still
  // has to reach somebody, so it goes to the log instead.
  const [account] = await owner`select 1 from account where id = ${input.accountId}::uuid`
  if (!account) {
    console.error(`[dead-letter] ${input.jobName} failed in an account that no longer exists:`, input.error)
    return
  }
  await recordAccountDeadLetter(systemContext(input.accountId), input)
}

/** Called once a job has used its last attempt, never on a retry. A run that named
 *  its failing accounts gets one dead letter each; a payload that names one gets
 *  that one; anything else gets the day's notice to its audience. */
export const recordJobFailure = async (
  job: Job,
  payload: unknown,
  cause: unknown,
  attempts: number,
): Promise<void> => {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (cause instanceof AccountFailures) {
    for (const [accountId, error] of cause.failures) {
      await recordDeadLetter({ accountId, jobName: job.name, payload: {}, error, attempts })
    }
    return
  }
  const accountId = accountIdOf(payload)
  if (accountId) {
    await recordDeadLetter({ accountId, jobName: job.name, payload, error: message, attempts })
    return
  }
  if (!job.audience) {
    console.error(`[dead-letter] ${job.name} failed and names no accounts:`, message)
    return
  }
  await notifyFamilyFailure(owner, job.name, job.audience, message)
}
