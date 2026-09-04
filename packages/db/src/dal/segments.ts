import { asc, desc, eq, sql, type SQL } from 'drizzle-orm'
import { segment, segmentMembership } from '../schema/marketing.ts'
import type { ObjectKey } from '../registry/core.ts'
import { recordActivity, type EntityType } from './activity.ts'
import { assertCanWrite, type WorkspaceContext } from './context.ts'
import { mutate, withWorkspace, type Tx } from './index.ts'
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
  lastEvaluatedAt: Date | null
}

const toObjectKey = (value: string): ObjectKey => {
  if (value !== 'contact' && value !== 'company' && value !== 'deal') {
    throw new Error(`"${value}" is not an object a segment can be built on.`)
  }
  return value
}

export const listSegments = async (ctx: WorkspaceContext, objectKey?: string): Promise<SegmentRow[]> =>
  withWorkspace(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const rows = await tx
      .select({
        id: segment.id,
        name: segment.name,
        objectId: segment.objectId,
        description: segment.description,
        query: segment.query,
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
export const saveSegment = async (ctx: WorkspaceContext, input: SaveSegmentInput): Promise<{ id: string }> =>
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
        workspaceId: ctx.workspaceId,
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

export const deleteSegment = async (ctx: WorkspaceContext, id: string): Promise<void> =>
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
  ctx: WorkspaceContext,
  segmentId: string,
): Promise<EvaluationResult> => {
  assertCanWrite(ctx, 'segment')
  return withWorkspace(ctx, (tx) => evaluateSegmentIn(tx, ctx, segmentId))
}

export const evaluateSegmentIn = async (
  tx: Tx,
  ctx: WorkspaceContext,
  segmentId: string,
): Promise<EvaluationResult> => {
  const registry = await getRegistryIn(tx)
  const [row] = await tx
    .select({ id: segment.id, name: segment.name, objectId: segment.objectId, query: segment.query })
    .from(segment)
    .where(eq(segment.id, segmentId))
    .limit(1)
  if (!row) throw new Error('That segment no longer exists.')

  const object = registry.objects.find((candidate) => candidate.id === row.objectId)
  if (!object) throw new Error(`The object "${row.name}" is built on no longer exists.`)

  const matching = matchingIds(object, parseFilters(row.query), ctx)

  const exited = await tx.execute<{ entity_id: string }>(sql`
    update segment_membership m
       set exited_at = now()
     where m.segment_id = ${segmentId}
       and m.exited_at is null
       and m.entity_id not in (${matching})
    returning m.entity_id`)

  const entered = await tx.execute<{ entity_id: string }>(sql`
    insert into segment_membership (workspace_id, segment_id, entity_id)
    select ${ctx.workspaceId}, ${segmentId}, candidate.id
      from (${matching}) as candidate(id)
     where not exists (
       select 1 from segment_membership m
        where m.segment_id = ${segmentId} and m.entity_id = candidate.id and m.exited_at is null)
    returning entity_id`)

  const entityType = ENTITY_TYPE[object.key]
  for (const member of entered) {
    await recordActivity(tx, ctx, {
      type: 'segment_change',
      subject: `entered ${row.name}`,
      payload: { segmentId, segmentName: row.name, direction: 'entered' },
      links: [{ entityType, entityId: member.entity_id }],
    })
  }
  for (const member of exited) {
    await recordActivity(tx, ctx, {
      type: 'segment_change',
      subject: `left ${row.name}`,
      payload: { segmentId, segmentName: row.name, direction: 'exited' },
      links: [{ entityType, entityId: member.entity_id }],
    })
  }

  await tx.update(segment).set({ lastEvaluatedAt: new Date() }).where(eq(segment.id, segmentId))

  const [{ n = 0 } = { n: 0 }] = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from segment_membership
         where segment_id = ${segmentId} and exited_at is null`,
  )

  return { entered: entered.length, exited: exited.length, members: Number(n) }
}

/** The id set a segment's query selects, as a subquery rather than a result. */
const matchingIds = (object: RegistryObject, filters: FilterGroup[], ctx: WorkspaceContext): SQL => {
  const where = compileFilters(object, filters, scopeFor(ctx.actorId))
  const table = sql.raw(`"${object.key}"`)
  const notDeleted = sql.raw(`"${object.key}"."deleted_at" is null`)
  return sql`select ${sql.raw(`"${object.key}"."id"`)} as id from ${table} where ${notDeleted}${where ? sql` and ${where}` : sql``}`
}

/** Every segment, on a schedule and after a bulk write. Returned per segment so a
 *  run that goes wrong on one does not read as a run that did nothing. */
export const evaluateAllSegments = async (
  ctx: WorkspaceContext,
): Promise<{ segmentId: string; name: string; result: EvaluationResult | null; error: string | null }[]> => {
  assertCanWrite(ctx, 'segment')
  return withWorkspace(ctx, async (tx) => {
    const rows = await tx.select({ id: segment.id, name: segment.name }).from(segment)
    const out: { segmentId: string; name: string; result: EvaluationResult | null; error: string | null }[] = []

    for (const row of rows) {
      // A savepoint per segment: one segment whose filter refers to a field that
      // has since been deleted must not abandon the others.
      const point = `seg_${out.length}`
      await tx.execute(sql.raw(`savepoint "${point}"`))
      try {
        const result = await evaluateSegmentIn(tx, ctx, row.id)
        await tx.execute(sql.raw(`release savepoint "${point}"`))
        out.push({ segmentId: row.id, name: row.name, result, error: null })
      } catch (cause) {
        await tx.execute(sql.raw(`rollback to savepoint "${point}"`))
        out.push({
          segmentId: row.id,
          name: row.name,
          result: null,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }
    return out
  })
}

export type SegmentMember = { id: string; displayName: string; enteredAt: Date }

export const readSegmentMembers = async (
  ctx: WorkspaceContext,
  segmentId: string,
  limit = 50,
): Promise<SegmentMember[]> =>
  withWorkspace(ctx, async (tx) => {
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
      displayName: displayName(object.key, member),
      enteredAt: member.entered_at instanceof Date ? member.entered_at : new Date(String(member.entered_at)),
    }))
  })

/** The segments one record is in, for the record page. Past spells included, so a
 *  contact who left last month still shows why they are no longer being mailed. */
export type MembershipRow = { segmentId: string; name: string; enteredAt: Date; exitedAt: Date | null }

export const readMemberships = async (
  ctx: WorkspaceContext,
  entityId: string,
): Promise<MembershipRow[]> =>
  withWorkspace(ctx, (tx) =>
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
  ctx: WorkspaceContext,
  input: { objectKey: string; filters: FilterGroup[] },
): Promise<{ count: number; sample: { id: string; displayName: string }[] }> =>
  withWorkspace(ctx, async (tx) => {
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
      sample: sample.map((row) => ({ id: String(row.id), displayName: displayName(object.key, row) })),
    }
  })
