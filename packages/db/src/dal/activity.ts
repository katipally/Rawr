import { and, count, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import { activity, activityLink } from '../schema/records.ts'
import { userAccount } from '../schema/identity.ts'
import type { activityTypeEnum, entityTypeEnum } from '../schema/enums.ts'
import type { WorkspaceContext } from './context.ts'
import { mutate, withWorkspace, type Tx } from './index.ts'

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

/** The same write, from outside a transaction. `recordActivity` is deliberately
 *  transaction-only so a committed change can never be missing its timeline entry;
 *  this is for the caller whose activity IS the change, which today is F5's
 *  log_activity tool and the "I had a call" it exists for. */
export const logActivity = async (
  ctx: WorkspaceContext,
  entry: NewActivity,
): Promise<{ id: string }> =>
  mutate(ctx, 'activity', async (tx) => {
    const id = await recordActivity(tx, ctx, entry)
    if (!id) throw new Error('That activity had no record to attach to.')
    return {
      result: { id },
      audit: {
        entity: 'activity',
        entityId: id,
        action: entry.type,
        before: null,
        after: { subject: entry.subject ?? null, links: entry.links },
      },
    }
  })

export type TimelineCursor = { occurredAt: Date; id: string }

export type TimelineRow = {
  id: string
  type: ActivityType
  subject: string | null
  body: string | null
  occurredAt: Date
  source: string | null
  payload: unknown
  actorId: string | null
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
        actorId: activity.actorId,
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

export type RecentActivityRow = TimelineRow & {
  /** The first record the entry hangs on, for the link. An entry on a contact,
   *  its company and a deal shows once, under the contact. */
  entityType: EntityRef['entityType']
  entityId: string
  entityName: string
}

/** The workspace's timeline, newest first: what the team did today, across every
 *  record, for the Home screen, and narrowed to a few types for a screen that is
 *  about one of them. One indexed scan of activity plus a lateral pick of one link
 *  per entry; O(limit), never a join over the whole link table. */
export const recentActivity = async (
  ctx: WorkspaceContext,
  limit = 12,
  types?: ActivityType[],
): Promise<RecentActivityRow[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      type: ActivityType
      subject: string | null
      body: string | null
      occurred_at: Date | string
      source: string | null
      payload: unknown
      actor_id: string | null
      actor_name: string | null
      actor_kind: string
      entity_type: EntityRef['entityType']
      entity_id: string
      entity_name: string | null
    }>(sql`
      select a.id, a.type, a.subject, a.body, a.occurred_at, a.source, a.payload,
             a.actor_id, u.name as actor_name, a.actor_kind,
             l.entity_type, l.entity_id,
             case l.entity_type
               when 'contact' then (select coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email) from contact c where c.id = l.entity_id)
               when 'company' then (select coalesce(co.name, co.domain) from company co where co.id = l.entity_id)
               when 'deal' then (select d.name from deal d where d.id = l.entity_id)
             end as entity_name
        from activity a
        left join user_account u on u.id = a.actor_id
        join lateral (
          select entity_type, entity_id from activity_link
           where activity_id = a.id
           order by case entity_type when 'contact' then 0 when 'deal' then 1 else 2 end
           limit 1
        ) l on true
       where ${
         types && types.length > 0
           ? sql`a.type in (${sql.join(
               types.map((type) => sql`${type}::rawr_activity_type`),
               sql`, `,
             )})`
           : sql`a.type <> 'page_view'`
       }
       order by a.occurred_at desc, a.id desc
       limit ${Math.min(Math.max(limit, 1), 100)}`)

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      subject: row.subject,
      body: row.body,
      occurredAt: new Date(row.occurred_at),
      source: row.source,
      payload: row.payload,
      actorId: row.actor_id,
      actorName: row.actor_name,
      actorKind: row.actor_kind,
      entityType: row.entity_type,
      entityId: row.entity_id,
      entityName: row.entity_name ?? 'a deleted record',
    }))
  })
