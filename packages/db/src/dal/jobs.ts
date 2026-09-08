import { and, desc, eq, isNull } from 'drizzle-orm'
import { deadLetter } from '../schema/platform.ts'
import { fieldIndex } from '../schema/metadata.ts'
import type { AccountContext } from './context.ts'
import { mutate, withAccount } from './index.ts'
import { notify } from './notifications.ts'

export type DeadLetterRow = {
  id: string
  jobName: string
  error: string
  attempts: number
  at: Date
  payload: unknown
}

/** A job that fails without landing one of these is a bug, not an incident.
 *  Written with withAccount rather than mutate: a dead letter is the record of
 *  a failure, not a change a person made, so it carries no audit row and no role
 *  check. The caller is always a job or the public edge, both of which have
 *  already been scoped by the time they get here. */
export const recordDeadLetter = async (
  ctx: AccountContext,
  entry: { jobName: string; payload: unknown; error: string; attempts: number },
): Promise<void> => {
  await withAccount(ctx, async (tx) => {
    await tx.insert(deadLetter).values({
      accountId: ctx.accountId,
      jobName: entry.jobName,
      payload: entry.payload ?? {},
      error: entry.error.slice(0, 2000),
      attempts: entry.attempts,
    })
    // Keyed by day, so a bad deploy is one line saying four hundred rather than
    // four hundred lines saying one.
    await notify(tx, ctx, {
      kind: 'dead_letter',
      dedupeKey: `dead_letter:${new Date().toISOString().slice(0, 10)}`,
      title: 'A job failed and can be replayed',
      body: `${entry.jobName}: ${entry.error.slice(0, 200)}`,
      to: { hubs: ['account'] },
    })
  })
}

export const listDeadLetters = async (ctx: AccountContext): Promise<DeadLetterRow[]> =>
  withAccount(ctx, (tx) =>
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

/** The index-build replay, and only that one.
 *
 *  Every other family goes through `server/integrations/replay.ts`, which is
 *  where the app's Replay button lands. This one stays because putting the row
 *  back to pending is the whole of it and needs no queue client, and because the
 *  guard suite exercises the role rules through it. */
export const replayDeadLetter = async (ctx: AccountContext, id: string): Promise<void> =>
  mutate(ctx, 'dead_letter', async (tx) => {
    const [row] = await tx
      .select({ jobName: deadLetter.jobName, payload: deadLetter.payload })
      .from(deadLetter)
      .where(and(eq(deadLetter.id, id), isNull(deadLetter.replayedAt)))
      .limit(1)

    if (!row) throw new Error('That failure has already been replayed, or it does not exist.')

    if (row.jobName !== 'field-index.create') {
      throw new Error(
        `${row.jobName} is not replayed here. This path rebuilds a field index; everything else replays through its own integration.`,
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
