import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Sql } from 'postgres'
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
  /** Null when the failure was never a queued job, which the table renders as
   *  "not queued" rather than as nought tries. */
  attempts: number | null
  at: Date
  payload: unknown
}

/** The notice for a permanent job failure. Keyed by job and day: a retry storm or a
 *  bad deploy is one line per job per day counting up, rather than one line per
 *  attempt, and two broken jobs on the same day are two lines. The key keeps the
 *  `dead_letter:` prefix that resolving a replayed failure matches on. Shared with
 *  the worker's fan-out, which writes the same key for accounts that had no row. */
export const deadLetterNotice = (jobName: string, error: string) => ({
  dedupeKey: `dead_letter:${jobName}:${new Date().toISOString().slice(0, 10)}`,
  title: 'A background job failed',
  body: `${jobName}: ${error.slice(0, 200)}`,
})

/** A job that fails without landing one of these is a bug, not an incident.
 *  Written with withAccount rather than mutate: a dead letter is the record of
 *  a failure, not a change a person made, so it carries no audit row and no role
 *  check. The caller is always a job or the public edge, both of which have
 *  already been scoped by the time they get here. */
export const recordDeadLetter = async (
  ctx: AccountContext,
  entry: { jobName: string; payload: unknown; error: string; attempts: number | null },
): Promise<void> => {
  await withAccount(ctx, async (tx) => {
    await tx.insert(deadLetter).values({
      accountId: ctx.accountId,
      jobName: entry.jobName,
      payload: entry.payload ?? {},
      error: entry.error.slice(0, 2000),
      attempts: entry.attempts,
    })
    await notify(tx, ctx, {
      kind: 'dead_letter',
      ...deadLetterNotice(entry.jobName, entry.error),
      to: { hubs: ['account'] },
    })
  })
}

/** A run that died before it could say whose failure it was: one notice per job per
 *  day to everybody with a say in each account in `audience`. Runs on the owner
 *  connection because it crosses tenants, and is one statement however many accounts
 *  the audience holds. `audience` is SQL returning one `account_id` column, written
 *  by the job that owns it. The recipient test is the one notify() applies to the
 *  `account` hub, and the upsert is the one it applies to a repeat. */
export const notifyFamilyFailure = async (
  owner: Sql,
  jobName: string,
  audience: string,
  error: string,
): Promise<void> => {
  const notice = deadLetterNotice(jobName, error)
  await owner.unsafe(
    `insert into notification (account_id, user_id, kind, dedupe_key, title, body)
     select m.account_id, m.user_id, 'dead_letter', $1, $2, $3
       from membership m
      where m.state = 'active'
        and m.account_id in (${audience})
        and (m.is_super_admin or m.edit_hubs && array['account']::rawr_hub[])
     on conflict (account_id, user_id, dedupe_key) do update
        set count = notification.count + 1,
            at = now(),
            title = excluded.title,
            body = excluded.body,
            read_at = null,
            trashed_at = null`,
    [notice.dedupeKey, notice.title, notice.body],
  )
}

const SEGMENT_JOB = 'segments.evaluate'

/** The segment pass's failures, one open dead letter per broken segment.
 *
 *  A pass that finds a segment broken refreshes that segment's open row (latest
 *  error, time, and a count of failing passes) rather than adding one a pass. A
 *  segment that evaluates again, or is deleted, closes its row. So does any row
 *  open from before rows carried a segment id: on the first pass after this, those
 *  are the same failures and would otherwise stay open beside their replacements.
 *
 *  One transaction, under an advisory lock per account, because the lookup of the
 *  open row is a read followed by a write. Two passes at once would both see no
 *  open row and both insert, and no unique index can say "one open row" here: a
 *  closed row must not block the next failure of the same segment. */
export const syncSegmentFailures = async (
  ctx: AccountContext,
  results: readonly { segmentId: string; name: string; error: string | null }[],
): Promise<void> => {
  const failing = results.flatMap((result) =>
    result.error === null ? [] : [{ segmentId: result.segmentId, name: result.name, error: result.error }],
  )
  const failingIds = new Set(failing.map((result) => result.segmentId))

  await withAccount(ctx, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${SEGMENT_JOB}:${ctx.accountId}`}, 0))`)

    const open = await tx
      .select({
        id: deadLetter.id,
        segmentId: sql<string | null>`${deadLetter.payload} ->> 'segmentId'`,
        attempts: deadLetter.attempts,
      })
      .from(deadLetter)
      .where(
        and(
          eq(deadLetter.accountId, ctx.accountId),
          eq(deadLetter.jobName, SEGMENT_JOB),
          isNull(deadLetter.replayedAt),
        ),
      )

    const stale = open.filter((row) => row.segmentId === null || !failingIds.has(row.segmentId))
    if (stale.length > 0) {
      await tx
        .update(deadLetter)
        .set({ replayedAt: new Date() })
        .where(inArray(deadLetter.id, stale.map((row) => row.id)))
    }

    const openBySegment = new Map(open.flatMap((row) => (row.segmentId ? [[row.segmentId, row] as const] : [])))
    for (const result of failing) {
      const payload = { segmentId: result.segmentId, segment: result.name }
      const error = result.error.slice(0, 2000)
      const row = openBySegment.get(result.segmentId)
      if (row) {
        await tx
          .update(deadLetter)
          .set({ payload, error, attempts: (row.attempts ?? 0) + 1, at: new Date() })
          .where(eq(deadLetter.id, row.id))
      } else {
        await tx.insert(deadLetter).values({
          accountId: ctx.accountId,
          jobName: SEGMENT_JOB,
          payload,
          error,
          attempts: 1,
        })
      }
      await notify(tx, ctx, { kind: 'dead_letter', ...deadLetterNotice(SEGMENT_JOB, result.error), to: { hubs: ['account'] } })
    }
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
  /** True when the worker has not yet created the queue or given this app access
   *  to it (SQLSTATE 42501, 42P01 or 3F000). Any other failure is logged and
   *  reported with this false. */
  notSetUp: boolean
}

const NOT_SET_UP_CODES = new Set(['42501', '42P01', '3F000'])

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
      notSetUp: false,
    }
  } catch (cause) {
    // drizzle may wrap the driver's error; the SQLSTATE sits on whichever one carries it.
    const driver = (cause as { cause?: { code?: string } } | null)?.cause ?? (cause as { code?: string } | null)
    const notSetUp = NOT_SET_UP_CODES.has(driver?.code ?? '')
    if (!notSetUp) console.error('[jobs] queue health could not be read:', cause)
    return { lastCompletedAt: null, waiting: 0, readable: false, notSetUp }
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
      .set({ state: 'pending', lastError: null, attempts: 0, claimedAt: null })
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
