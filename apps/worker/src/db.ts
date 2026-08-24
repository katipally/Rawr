import postgres from 'postgres'
import { OWNER_URL } from './env.ts'

/** One owner connection for the worker's own bookkeeping: the pg-boss schema, the
 *  dead-letter table, and the single function that emits DDL. Nothing here reads
 *  tenant records; that goes through @rawr/db so row level security applies. */
export const owner = postgres(OWNER_URL, { max: 2, onnotice: () => {} })

export const recordDeadLetter = async (input: {
  workspaceId: string | null
  jobName: string
  payload: unknown
  error: string
  attempts: number
}): Promise<void> => {
  if (!input.workspaceId) {
    // Nothing can be scoped, so it cannot be written to a tenant table. Losing it
    // silently would be worse than a loud log line.
    console.error(`[dead-letter] ${input.jobName} failed with no workspace id:`, input.error)
    return
  }
  await owner`
    insert into dead_letter (workspace_id, job_name, payload, error, attempts)
    values (${input.workspaceId}, ${input.jobName}, ${owner.json(input.payload as never)},
            ${input.error}, ${input.attempts})`
}
