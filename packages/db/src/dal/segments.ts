import { asc, desc, eq, sql, type SQL } from 'drizzle-orm'
import { segment, segmentMembership } from '../schema/marketing.ts'
import type { ObjectKey } from '../registry/core.ts'
import { recordActivityFanout, type EntityType } from './activity.ts'
import { assertCanWrite, type AccountContext } from './context.ts'
import { mutate, withAccount, type Tx } from './index.ts'
import { compileFilters, parseFilters, scopeFor, type FilterGroup } from './query.ts'
import { displayName } from './records.ts'
import { getRegistryIn, objectOrThrow, type RegistryObject } from './registry.ts'

/** A segment is a saved query with remembered membership. D15 put it in F1 rather
 *  than a later feature, and everything downstream assumes it: F6 pushes a segment
 *  to Brevo as a list, and the timeline is supposed to show somebody entering and
 *  leaving one.
 *
 *  Two things make this more than a saved filter:
 *
 *  MEMBERSHIP IS STORED. Evaluating the query on every read would answer "who is in
 *  this now" and could never answer "when did they join". segment_membership holds
 *  entered_at and exited_at, so a contact who left in March still reads as having
 *  been a customer in February.
 *
 *  ENTRY AND EXIT ARE EVENTS. Both write a segment_change activity on the record,
 *  because "joined High-value trials" is exactly the kind of thing somebody opening
 *  a contact needs to see next to the emails and the meetings. A2. */

export type SegmentRow = {
  id: string
  name: string
  objectKey: ObjectKey
  description: string | null
  filters: FilterGroup[]
  memberCount: number
  /** An imported list, holding the members a file named rather than the members a
   *  query selects. The evaluator leaves it alone; the screen says so. */
  isStatic: boolean
  lastEvaluatedAt: Date | null
}

const toObjectKey = (value: string): ObjectKey => {
  if (value !== 'contact' && value !== 'company' && value !== 'deal') {
    throw new Error(`"${value}" is not an object a segment can be built on.`)
  }
  return value
}

export const listSegments = async (ctx: AccountContext, objectKey?: string): Promise<SegmentRow[]> =>
  withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const rows = await tx
      .select({
        id: segment.id,
        name: segment.name,
        objectId: segment.objectId,
        description: segment.description,
        query: segment.query,
        isStatic: segment.isStatic,
        lastEvaluatedAt: segment.lastEvaluatedAt,
      })
      .from(segment)
      .orderBy(asc(segment.name))

    const counts = await tx.execute<{ segment_id: string; n: number }>(
      sql`select segment_id, count(*)::int as n from segment_membership
           where exited_at is null group by segment_id`,
    )
    const byId = new Map(counts.map((row) => [row.segment_id, Number(row.n)]))
    const objectById = new Map(registry.objects.map((object) => [object.id, object.key]))

    return rows
      .filter((row) => !objectKey || objectById.get(row.objectId) === objectKey)
      .map((row) => ({
        id: row.id,
        name: row.name,
        objectKey: toObjectKey(objectById.get(row.objectId) ?? 'contact'),
        description: row.description,
        filters: parseFilters(row.query),
        memberCount: byId.get(row.id) ?? 0,
        isStatic: row.isStatic,
        lastEvaluatedAt: row.lastEvaluatedAt,
      }))
  })

export type SaveSegmentInput = {
  id?: string | null
  objectKey: string
  name: string
  description?: string | null
  filters: FilterGroup[]
}

/** Saving compiles the query once so a filter that cannot run is refused here,
 *  where somebody is looking at the builder, rather than silently producing an
 *  empty segment on the next scheduled pass. */
export const saveSegment = async (ctx: AccountContext, input: SaveSegmentInput): Promise<{ id: string }> =>
  mutate(ctx, 'segment', async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, input.objectKey)
    const name = input.name.trim()
    if (!name) throw new Error('A segment needs a name.')
    if (input.filters.length === 0 || input.filters.every((group) => group.conditions.length === 0)) {
      throw new Error('A segment with no conditions would hold every record. Add at least one.')
    }

    // Throws with the field and operator named if the query is not runnable.
    compileFilters(object, input.filters, scopeFor(ctx.actorId))

    if (input.id) {
      const [before] = await tx
        .select({ name: segment.name, query: segment.query })
        .from(segment)
        .where(eq(segment.id, input.id))
        .limit(1)
      if (!before) throw new Error('That segment no longer exists.')

      await tx
        .update(segment)
        .set({
          name,
          description: input.description?.trim() || null,
          query: input.filters,
          objectId: object.id,
        })
        .where(eq(segment.id, input.id))

      return {
        result: { id: input.id },
        audit: { entity: 'segment', entityId: input.id, action: 'update', before, after: { name, query: input.filters } },
      }
    }

    const [created] = await tx
      .insert(segment)
      .values({
        accountId: ctx.accountId,
        objectId: object.id,
        name,
        description: input.description?.trim() || null,
        query: input.filters,
      })
      .returning({ id: segment.id })
    if (!created) throw new Error('The segment could not be created.')

    return {
      result: { id: created.id },
      audit: { entity: 'segment', entityId: created.id, action: 'create', before: null, after: { name } },
    }
  })

export const deleteSegment = async (ctx: AccountContext, id: string): Promise<void> =>
  mutate(ctx, 'segment', async (tx) => {
    const [found] = await tx.select({ name: segment.name }).from(segment).where(eq(segment.id, id)).limit(1)
    if (!found) throw new Error('That segment no longer exists.')

    // Membership history goes with it. The timeline entries stay, because they
    // record something that actually happened to the contact.
    await tx.delete(segmentMembership).where(eq(segmentMembership.segmentId, id))
    await tx.delete(segment).where(eq(segment.id, id))

    return {
      result: undefined,
      audit: { entity: 'segment', entityId: id, action: 'delete', before: found, after: null },
    }
  })

export type EvaluationResult = { entered: number; exited: number; members: number }

const ENTITY_TYPE: Record<ObjectKey, EntityType> = { contact: 'contact', company: 'company', deal: 'deal' }

/** Recomputes one segment and writes the difference.
 *
 *  Set difference in SQL rather than in memory: at 88,270 contacts, loading both
 *  sides to diff them in JavaScript is the wrong shape. Two statements do the whole
 *  job — one marks the rows that no longer match as exited, one inserts the rows
 *  that newly match — and both return the ids they touched so the timeline entries
 *  can be written for exactly those.
 *
 *  Re-entry is a new row, not an un-exit. Somebody who was a customer, churned, and
 *  came back has two spells, and collapsing them would erase the churn. */
export const evaluateSegment = async (
  ctx: AccountContext,
  segmentId: string,
): Promise<EvaluationResult> => {
  assertCanWrite(ctx, 'segment')
  return withAccount(ctx, (tx) => evaluateSegmentIn(tx, ctx, segmentId))
}

export const evaluateSegmentIn = async (
  tx: Tx,
  ctx: AccountContext,
  segmentId: string,
): Promise<EvaluationResult> => {
  const registry = await getRegistryIn(tx)
  const [row] = await tx
    .select({
      id: segment.id,
      name: segment.name,
      objectId: segment.objectId,
      query: segment.query,
      isStatic: segment.isStatic,
    })
    .from(segment)
    .where(eq(segment.id, segmentId))
    .limit(1)
  if (!row) throw new Error('That segment no longer exists.')

  // An imported list holds the members a file named, not the members a query
  // selects. Rebuilding it from the empty query it carries would empty it, and
  // the hourly run would do that to all of them on the first pass after a
  // migration. Reported as a real result rather than an error: nothing is wrong,
  // there is simply nothing to recompute.
  if (row.isStatic) {
    const [{ n = 0 } = { n: 0 }] = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from segment_membership
           where segment_id = ${segmentId} and exited_at is null`,
    )
    return { entered: 0, exited: 0, members: Number(n) }
  }

  const object = registry.objects.find((candidate) => candidate.id === row.objectId)
  if (!object) throw new Error(`The object "${row.name}" is built on no longer exists.`)

  const matching = matchingIds(object, parseFilters(row.query), ctx)

  // Both sides are put into temporary tables first, and both are analysed.
  //
  // The shape matters more than the wording here, and two things went wrong
  // before this. `not in` against a subquery cannot be turned into an anti-join
  // at all, because a null in the subquery would change the answer. And once
  // that was a left join, the planner still chose a nested loop, because a list
  // arriving from HubSpot puts eighty thousand rows into segment_membership
  // before autovacuum has looked at it, so the estimate for that side was one
  // row. A hundred thousand member segment re-evaluated on that plan had not
  // finished after twelve minutes.
  //
  // Temporary tables fix both: they are owned by this session, so `analyze` is
  // permitted where it is refused on segment_membership, and the join then has
  // real row counts on both sides. They drop with the transaction.
  // `if not exists` and a truncate rather than a plain create: these drop at
  // commit, but a pooled backend that was handed back mid-transaction can still
  // be holding a pair from an earlier caller, and a create that fails there would
  // fail the evaluation rather than reuse them.
  await tx.execute(sql`create temporary table if not exists segment_candidate (id uuid primary key) on commit drop`)
  await tx.execute(sql`create temporary table if not exists segment_held (id uuid primary key) on commit drop`)
  await tx.execute(sql`truncate segment_candidate, segment_held`)
  await tx.execute(sql`insert into segment_candidate (id) select id from (${matching}) as m(id)`)
  await tx.execute(sql`
    insert into segment_held (id)
    select entity_id from segment_membership where segment_id = ${segmentId} and exited_at is null`)
  await tx.execute(sql`analyze segment_candidate`)
  await tx.execute(sql`analyze segment_held`)

  const exited = await tx.execute<{ entity_id: string }>(sql`
    update segment_membership m
       set exited_at = now()
      from (
        select held.id from segment_held held
          left join segment_candidate candidate on candidate.id = held.id
         where candidate.id is null
      ) gone
     where m.segment_id = ${segmentId}
       and m.exited_at is null
       and m.entity_id = gone.id
    returning m.entity_id`)

  const entered = await tx.execute<{ entity_id: string }>(sql`
    insert into segment_membership (account_id, segment_id, entity_id)
    select ${ctx.accountId}, ${segmentId}, candidate.id
      from segment_candidate candidate
      left join segment_held held on held.id = candidate.id
     where held.id is null
    returning entity_id`)

  await recordActivityFanout(tx, ctx, {
    type: 'segment_change',
    subject: `entered ${row.name}`,
    payload: { segmentId, segmentName: row.name, direction: 'entered' },
    entityType: object.key,
    entityIds: entered.map((member) => member.entity_id),
  })
  await recordActivityFanout(tx, ctx, {
    type: 'segment_change',
    subject: `left ${row.name}`,
    payload: { segmentId, segmentName: row.name, direction: 'exited' },
    entityType: object.key,
    entityIds: exited.map((member) => member.entity_id),
  })

  await tx.update(segment).set({ lastEvaluatedAt: new Date() }).where(eq(segment.id, segmentId))

  const [{ n = 0 } = { n: 0 }] = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from segment_membership
         where segment_id = ${segmentId} and exited_at is null`,
  )

  return { entered: entered.length, exited: exited.length, members: Number(n) }
}

/** The id set a segment's query selects, as a subquery rather than a result. */
const matchingIds = (object: RegistryObject, filters: FilterGroup[], ctx: AccountContext): SQL => {
  const where = compileFilters(object, filters, scopeFor(ctx.actorId))
  const table = sql.raw(`"${object.key}"`)
  const notDeleted = sql.raw(`"${object.key}"."deleted_at" is null`)
  return sql`select ${sql.raw(`"${object.key}"."id"`)} as id from ${table} where ${notDeleted}${where ? sql` and ${where}` : sql``}`
}

/** Every segment, on a schedule and after a bulk write. Returned per segment so a
 *  run that goes wrong on one does not read as a run that did nothing.
 *
 *  A transaction each, not one transaction with a savepoint each. At the size of
 *  the portal, 129 lists at seconds apiece is a transaction open for minutes: it
 *  pins the vacuum horizon so nothing anywhere in the database can be cleaned
 *  while it runs, it holds every membership row it has touched locked against
 *  somebody editing that segment in the app, and a dropped connection or a
 *  statement timeout at minute nine throws away the first eight minutes of work.
 *  Committing each segment gives all three back, and the caller was already
 *  reading the results one segment at a time.
 *
 *  Sequential on purpose. This is an hourly background job, and running it wide
 *  would put several whole-table writes on the pool at once for no gain that
 *  anybody is waiting on. */
export const evaluateAllSegments = async (
  ctx: AccountContext,
): Promise<{ segmentId: string; name: string; result: EvaluationResult | null; error: string | null }[]> => {
  assertCanWrite(ctx, 'segment')
  const rows = await withAccount(ctx, (tx) =>
    tx.select({ id: segment.id, name: segment.name }).from(segment),
  )

  const out: { segmentId: string; name: string; result: EvaluationResult | null; error: string | null }[] = []
  for (const row of rows) {
    try {
      const result = await withAccount(ctx, (tx) => evaluateSegmentIn(tx, ctx, row.id))
      out.push({ segmentId: row.id, name: row.name, result, error: null })
    } catch (cause) {
      // One segment whose filter names a field that has since been deleted must
      // not take the others with it. Its own transaction has already rolled back.
      out.push({
        segmentId: row.id,
        name: row.name,
        result: null,
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
  return out
}

export type SegmentMember = { id: string; displayName: string; enteredAt: Date }

export const readSegmentMembers = async (
  ctx: AccountContext,
  segmentId: string,
  limit = 50,
): Promise<SegmentMember[]> =>
  withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const [row] = await tx
      .select({ objectId: segment.objectId })
      .from(segment)
      .where(eq(segment.id, segmentId))
      .limit(1)
    if (!row) throw new Error('That segment no longer exists.')
    const object = registry.objects.find((candidate) => candidate.id === row.objectId)
    if (!object) throw new Error('The object this segment is built on no longer exists.')

    const labelColumns =
      object.key === 'contact'
        ? sql.raw(`r."first_name", r."last_name", r."email"`)
        : sql.raw(`r."name"${object.key === 'company' ? ', r."domain"' : ''}`)

    const rows = await tx.execute<Record<string, unknown> & { id: string; entered_at: Date }>(sql`
      select r.id, m.entered_at, ${labelColumns}
        from segment_membership m
        join ${sql.raw(`"${object.key}"`)} r on r.id = m.entity_id
       where m.segment_id = ${segmentId} and m.exited_at is null and r.deleted_at is null
       order by m.entered_at desc
       limit ${Math.min(Math.max(limit, 1), 200)}`)

    return rows.map((member) => ({
      id: String(member.id),
      displayName: displayName(object, member),
      enteredAt: member.entered_at instanceof Date ? member.entered_at : new Date(String(member.entered_at)),
    }))
  })

/** The segments one record is in, for the record page. Past spells included, so a
 *  contact who left last month still shows why they are no longer being mailed. */
export type MembershipRow = { segmentId: string; name: string; enteredAt: Date; exitedAt: Date | null }

export const readMemberships = async (
  ctx: AccountContext,
  entityId: string,
): Promise<MembershipRow[]> =>
  withAccount(ctx, (tx) =>
    tx
      .select({
        segmentId: segment.id,
        name: segment.name,
        enteredAt: segmentMembership.enteredAt,
        exitedAt: segmentMembership.exitedAt,
      })
      .from(segmentMembership)
      .innerJoin(segment, eq(segment.id, segmentMembership.segmentId))
      .where(eq(segmentMembership.entityId, entityId))
      .orderBy(desc(segmentMembership.enteredAt))
      .limit(50),
  )

/** A dry run for the builder: how many records the query selects right now, and a
 *  few of them, so nobody saves a segment without seeing what is in it. */
export const previewSegment = async (
  ctx: AccountContext,
  input: { objectKey: string; filters: FilterGroup[] },
): Promise<{ count: number; sample: { id: string; displayName: string }[] }> =>
  withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, input.objectKey)
    const ids = matchingIds(object, input.filters, ctx)

    const [countRow] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from (${ids}) as matched`)

    const labelColumns =
      object.key === 'contact'
        ? sql.raw(`r."first_name", r."last_name", r."email"`)
        : sql.raw(`r."name"${object.key === 'company' ? ', r."domain"' : ''}`)

    const sample = await tx.execute<Record<string, unknown> & { id: string }>(sql`
      select r.id, ${labelColumns}
        from ${sql.raw(`"${object.key}"`)} r
       where r.id in (${ids})
       order by r.created_at desc
       limit 10`)

    return {
      count: Number(countRow?.n ?? 0),
      sample: sample.map((row) => ({ id: String(row.id), displayName: displayName(object, row) })),
    }
  })
