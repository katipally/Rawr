import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
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

export type QueueHealth = {
  /** When the dispatcher last finished a job. Null means it has never finished
   *  one, which on a database whose worker has never booted is the honest answer. */
  lastCompletedAt: Date | null
  /** Waiting or retrying right now. A number that climbs while `lastCompletedAt`
   *  stands still is the shape of a worker that has stopped. */
  waiting: number
  /** False when the queue's own tables cannot be read, so the page says "cannot
   *  tell" rather than drawing a dead worker out of a missing grant. */
  readable: boolean
}

/** Whether anything is running at all.
 *
 *  /settings/jobs lists jobs that failed, and an empty list means either that
 *  everything is well or that nothing has run since Tuesday. Those are opposite
 *  facts and they rendered identically.
 *
 *  Read straight from pg-boss rather than from a heartbeat table Rawr keeps: the
 *  queue already knows, and a second copy of the truth is a second thing to be
 *  wrong. The grant is in sql/bootstrap.sql, read only and on this table alone.
 *
 *  Account-agnostic on purpose. A worker is a process, not a tenant, and it is the
 *  same process for every account in this deployment. Nothing here reads or
 *  returns a payload, so no account's data crosses through it. */
export const queueHealth = async (): Promise<QueueHealth> => {
  try {
    const [row] = await appDb.execute<{ last_completed: Date | null; waiting: string }>(
      sql`select max(completed_on) filter (where state = 'completed') as last_completed,
                 count(*) filter (where state in ('created', 'retry')) as waiting
            from pgboss.job_common`,
    )
    return {
      lastCompletedAt: row?.last_completed ? new Date(row.last_completed) : null,
      waiting: Number(row?.waiting ?? 0),
      readable: true,
    }
  } catch {
    // No pgboss schema yet, or the grant has not been applied. Either way the
    // question is unanswerable, which is not the same as a bad answer.
    return { lastCompletedAt: null, waiting: 0, readable: false }
  }
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
