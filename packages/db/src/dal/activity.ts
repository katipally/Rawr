import { and, count, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import { activity, activityLink } from '../schema/records.ts'
import { userAccount } from '../schema/identity.ts'
import type { activityTypeEnum, entityTypeEnum } from '../schema/enums.ts'
import type { WorkspaceContext } from './context.ts'
import { withWorkspace, type Tx } from './index.ts'

export type ActivityType = (typeof activityTypeEnum.enumValues)[number]
export type EntityType = (typeof entityTypeEnum.enumValues)[number]

export type EntityRef = { entityType: EntityType; entityId: string }

export type NewActivity = {
  type: ActivityType
  subject?: string | null
  body?: string | null
  /** When it happened. Migration and identity stitching both write past-dated
   *  activity, and the timeline sorts on this, not on when Rawr learned it. A3. */
  occurredAt?: Date
  source?: string | null
  payload?: unknown
  links: EntityRef[]
}

/** The timeline filter's tab order, and the only list a surface should iterate.
 *  A3: twenty types, reduced from HubSpot's 44-type filter set. */
export const ACTIVITY_GROUPS: { label: string; types: ActivityType[] }[] = [
  { label: 'Human', types: ['note', 'task', 'call', 'meeting', 'email'] },
  { label: 'System', types: ['stage_change', 'lifecycle_change', 'field_change', 'association_change', 'merge', 'import'] },
  { label: 'Capture', types: ['form_submission', 'booking', 'page_view', 'custom_event'] },
  { label: 'Marketing', types: ['marketing_email', 'email_tracking', 'sequence_activity'] },
  { label: 'Data', types: ['enrichment', 'subscription_change', 'segment_change'] },
]

export const ACTIVITY_TYPES: ActivityType[] = ACTIVITY_GROUPS.flatMap((group) => group.types)

const ACTIVITY_TYPE_SET = new Set<string>(ACTIVITY_TYPES)

export const isActivityType = (value: string): value is ActivityType => ACTIVITY_TYPE_SET.has(value)

/** Written inside the caller's transaction, always, so a committed change whose
 *  timeline entry is missing is not a reachable state. */
export const recordActivity = async (
  tx: Tx,
  ctx: WorkspaceContext,
  entry: NewActivity,
): Promise<string | null> => {
  const links = entry.links.filter((link) => link.entityId)
  if (links.length === 0) return null

  const occurredAt = entry.occurredAt ?? new Date()
  const [row] = await tx
    .insert(activity)
    .values({
      workspaceId: ctx.workspaceId,
      type: entry.type,
      subject: entry.subject ?? null,
      body: entry.body ?? null,
      occurredAt,
      actorId: ctx.actorId,
      actorKind: ctx.actorKind,
      source: entry.source ?? null,
      payload: entry.payload ?? null,
    })
    .returning({ id: activity.id })

  if (!row) throw new Error('The timeline entry could not be written.')

  await tx
    .insert(activityLink)
    .values(
      links.map((link) => ({
        workspaceId: ctx.workspaceId,
        activityId: row.id,
        entityType: link.entityType,
        entityId: link.entityId,
        type: entry.type,
        occurredAt,
      })),
    )
    .onConflictDoNothing()

  return row.id
}

export type TimelineCursor = { occurredAt: Date; id: string }

export type TimelineRow = {
  id: string
  type: ActivityType
  subject: string | null
  body: string | null
  occurredAt: Date
  source: string | null
  payload: unknown
  actorName: string | null
  actorKind: string
}

export type TimelinePage = { rows: TimelineRow[]; nextCursor: TimelineCursor | null }

/** Keyset on (occurred_at, id) straight off activity_link's timeline index, so a
 *  contact with 4,000 events opens as fast as one with three. */
export const readTimeline = async (
  ctx: WorkspaceContext,
  input: {
    entity: EntityRef
    types?: ActivityType[]
    limit?: number
    cursor?: TimelineCursor | null
  },
): Promise<TimelinePage> => {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  const { entityType, entityId } = input.entity

  const rows = await withWorkspace(ctx, (tx) =>
    tx
      .select({
        id: activity.id,
        type: activity.type,
        subject: activity.subject,
        body: activity.body,
        occurredAt: activity.occurredAt,
        source: activity.source,
        payload: activity.payload,
        actorName: userAccount.name,
        actorKind: activity.actorKind,
      })
      .from(activityLink)
      .innerJoin(activity, eq(activity.id, activityLink.activityId))
      .leftJoin(userAccount, eq(userAccount.id, activity.actorId))
      .where(
        and(
          eq(activityLink.entityType, entityType),
          eq(activityLink.entityId, entityId),
          input.types && input.types.length > 0
            ? inArray(activityLink.type, input.types)
            : undefined,
          input.cursor
            ? or(
                lt(activityLink.occurredAt, input.cursor.occurredAt),
                and(
                  eq(activityLink.occurredAt, input.cursor.occurredAt),
                  lt(activityLink.activityId, input.cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(activityLink.occurredAt), desc(activityLink.activityId))
      .limit(limit + 1),
  )

  const page = rows.slice(0, limit)
  const more = rows.length > limit ? page.at(-1) : undefined
  return {
    rows: page as TimelineRow[],
    nextCursor: more ? { occurredAt: more.occurredAt, id: more.id } : null,
  }
}

/** One grouped count query, never "load everything and count in memory". This is
 *  what feeds HubSpot's Activity (28/42) control. */
export const timelineCounts = async (
  ctx: WorkspaceContext,
  entity: EntityRef,
): Promise<Record<string, number>> => {
  const rows = await withWorkspace(ctx, (tx) =>
    tx
      .select({ type: activityLink.type, n: count() })
      .from(activityLink)
      .where(
        and(
          eq(activityLink.entityType, entity.entityType),
          eq(activityLink.entityId, entity.entityId),
        ),
      )
      .groupBy(activityLink.type),
  )
  return Object.fromEntries(rows.map((row) => [row.type, Number(row.n)]))
}

/** Moves every activity link from one record onto another, leaving no orphan and no
 *  duplicate. Two statements rather than one: data-modifying CTEs share a snapshot,
 *  so an update and a delete over the same rows in one statement is undefined. */
export const moveActivityLinks = async (
  tx: Tx,
  ctx: WorkspaceContext,
  from: EntityRef,
  to: EntityRef,
): Promise<number> => {
  // Links the survivor already carries would violate the primary key, so they go
  // first. The activity itself is untouched and stays visible on the survivor.
  await tx.execute(sql`
    delete from activity_link l
     where l.workspace_id = ${ctx.workspaceId}
       and l.entity_type = ${from.entityType}
       and l.entity_id = ${from.entityId}
       and exists (
         select 1 from activity_link keep
          where keep.workspace_id = l.workspace_id
            and keep.activity_id = l.activity_id
            and keep.entity_type = ${to.entityType}
            and keep.entity_id = ${to.entityId}
       )`)

  const moved = await tx
    .update(activityLink)
    .set({ entityId: to.entityId, entityType: to.entityType })
    .where(
      and(
        eq(activityLink.entityType, from.entityType),
        eq(activityLink.entityId, from.entityId),
      ),
    )
    .returning({ activityId: activityLink.activityId })

  return moved.length
}
