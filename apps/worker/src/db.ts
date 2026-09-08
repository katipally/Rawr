import postgres from 'postgres'
import { OWNER_URL } from './env.ts'

/** One owner connection for the worker's own bookkeeping: the pg-boss schema, the
 *  dead-letter table, and the single function that emits DDL. Nothing here reads
 *  tenant records; that goes through @rawr/db so row level security applies. */
export const owner = postgres(OWNER_URL, { max: 2, onnotice: () => {} })

export const recordDeadLetter = async (input: {
  accountId: string | null
  jobName: string
  payload: unknown
  error: string
  attempts: number
}): Promise<void> => {
  if (!input.accountId) {
    // Nothing can be scoped, so it cannot be written to a tenant table. Losing it
    // silently would be worse than a loud log line.
    console.error(`[dead-letter] ${input.jobName} failed with no account id:`, input.error)
    return
  }
  // A account deleted while its jobs were still in flight would fail the
  // foreign key, and that error would replace the one being recorded. The
  // failure still has to reach somebody, so it goes to the log instead.
  const written = await owner`
    insert into dead_letter (account_id, job_name, payload, error, attempts)
    select ${input.accountId}::uuid, ${input.jobName}, ${owner.json(input.payload as never)}::jsonb,
           ${input.error}, ${input.attempts}::int
    where exists (select 1 from account where id = ${input.accountId}::uuid)`
  if (written.count === 0) {
    console.error(`[dead-letter] ${input.jobName} failed in a account that no longer exists:`, input.error)
  }
}
