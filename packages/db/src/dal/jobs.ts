import { and, desc, eq, isNull } from 'drizzle-orm'
import { deadLetter } from '../schema/platform.ts'
import { fieldIndex } from '../schema/metadata.ts'
import type { WorkspaceContext } from './context.ts'
import { mutate, withWorkspace } from './index.ts'

export type DeadLetterRow = {
  id: string
  jobName: string
  error: string
  attempts: number
  at: Date
  payload: unknown
}

/** A job that fails without landing one of these is a bug, not an incident.
 *  Written with withWorkspace rather than mutate: a dead letter is the record of
 *  a failure, not a change a person made, so it carries no audit row and no role
 *  check. The caller is always a job or the public edge, both of which have
 *  already been scoped by the time they get here. */
export const recordDeadLetter = async (
  ctx: WorkspaceContext,
  entry: { jobName: string; payload: unknown; error: string; attempts: number },
): Promise<void> => {
  await withWorkspace(ctx, async (tx) => {
    await tx.insert(deadLetter).values({
      workspaceId: ctx.workspaceId,
      jobName: entry.jobName,
      payload: entry.payload ?? {},
      error: entry.error.slice(0, 2000),
      attempts: entry.attempts,
    })
  })
}

export const listDeadLetters = async (ctx: WorkspaceContext): Promise<DeadLetterRow[]> =>
  withWorkspace(ctx, (tx) =>
    tx
      .select({
        id: deadLetter.id,
        jobName: deadLetter.jobName,
        error: deadLetter.error,
        attempts: deadLetter.attempts,
        at: deadLetter.at,
        payload: deadLetter.payload,
      })
      .from(deadLetter)
      .where(isNull(deadLetter.replayedAt))
      .orderBy(desc(deadLetter.at))
      .limit(200),
  )

/** Replay is per job family, deliberately. A generic "re-send this payload" would
 *  need a queue client in the web app and would happily re-run something whose
 *  preconditions have since changed. For an index build, putting the row back to
 *  pending is the whole of it: the dispatcher claims it again within the minute. */
export const replayDeadLetter = async (ctx: WorkspaceContext, id: string): Promise<void> =>
  mutate(ctx, 'dead_letter', async (tx) => {
    const [row] = await tx
      .select({ jobName: deadLetter.jobName, payload: deadLetter.payload })
      .from(deadLetter)
      .where(and(eq(deadLetter.id, id), isNull(deadLetter.replayedAt)))
      .limit(1)

    if (!row) throw new Error('That failure has already been replayed, or it does not exist.')

    if (row.jobName !== 'field-index.create') {
      throw new Error(
        `${row.jobName} has no replay path yet. Only field-index.create can be replayed today.`,
      )
    }

    const fieldIndexId = (row.payload as { fieldIndexId?: unknown } | null)?.fieldIndexId
    if (typeof fieldIndexId !== 'string') {
      throw new Error('That failure has no index to rebuild, so there is nothing to replay.')
    }

    const reset = await tx
      .update(fieldIndex)
      .set({ state: 'pending', lastError: null })
      .where(eq(fieldIndex.id, fieldIndexId))
      .returning({ id: fieldIndex.id })

    if (reset.length === 0) {
      throw new Error('The field this failure refers to has since been deleted.')
    }

    await tx.update(deadLetter).set({ replayedAt: new Date() }).where(eq(deadLetter.id, id))

    return {
      result: undefined,
      audit: {
        entity: 'dead_letter',
        entityId: id,
        action: 'replay',
        before: { replayedAt: null },
        after: { replayedAt: 'now', fieldIndexId },
      },
    }
  })
