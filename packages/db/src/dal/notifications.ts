import { and, eq, isNull, sql } from 'drizzle-orm'
import { notification } from '../schema/notification.ts'
import type { AccountContext, Hub } from './context.ts'
import { withAccount, type Tx } from './index.ts'
import { entityAlive } from './registry.ts'

/** What the bell has to say, kept rather than recomputed.
 *
 *  Every row is addressed to one person. The reader is scoped on `ctx.actorId`
 *  throughout and no function here takes a user id from its caller, so asking for
 *  somebody else's list is not a thing the shape allows.
 *
 *  Written with `withAccount` and never `mutate`: a notification records
 *  something that happened, it is not an audited change, which is the same
 *  reasoning `recordDeadLetter` states. */

export type NotificationKind =
  | 'task_overdue'
  | 'form_submission'
  | 'form_quarantined'
  | 'deal_stage_change'
  | 'dead_letter'
  | 'integration_error'
  | 'mailbox_revoked'
  | 'task_reminder'
  | 'task_assigned'

export type NotificationTab = 'unread' | 'all' | 'trash'

export type NotificationRow = {
  id: string
  kind: NotificationKind
  title: string
  body: string | null
  entity: string | null
  entityId: string | null
  count: number
  readAt: Date | null
  trashedAt: Date | null
  at: Date
}

export type NotificationCursor = { at: string; id: string }

export type NotificationPage = {
  rows: NotificationRow[]
  /** Null when this is the last page. Keyset, never OFFSET, so page twenty costs
   *  what page one costs. */
  nextCursor: NotificationCursor | null
}

/** Who a notification is for: named people, or everybody who may write one of
 *  these hubs. A super admin writes every hub, so they are always in the second
 *  set without being named in it. */
export type Recipients = { userIds: string[] } | { hubs: Hub[] }

export type NotifyInput = {
  kind: NotificationKind
  /** Same event, same key. This is the whole of the deduplication. */
  dedupeKey: string
  title: string
  body?: string | null
  entity?: string | null
  entityId?: string | null
  to: Recipients
}

/** Bounded so a pathological unread count is one small scan and renders as
 *  "99+" rather than counting a million rows to draw a badge. */
const BADGE_CAP = 100
const PAGE = 30
const MAX_PAGE = 100

/** Records one thing that happened, for everybody it happened to.
 *
 *  Takes the open transaction rather than opening its own, so the notice and the
 *  thing it is about are written together: a form fill that saves and then fails
 *  to notify would leave a lead nobody is told about. */
export const notify = async (tx: Tx, ctx: AccountContext, input: NotifyInput): Promise<void> => {
  // The actor never hears about their own action. Excluded here rather than at
  // each call site, because every call site would otherwise have to remember.
  const audience =
    'userIds' in input.to
      // One bound parameter per id rather than one for the array: drizzle sends a
      // JS array as a row constructor, and `(a, b)::uuid[]` is a cast Postgres
      // refuses outright.
      ? sql`select unnest(array[${sql.join(
          input.to.userIds.map((userId) => sql`${userId}::uuid`),
          sql`, `,
        )}]) as user_id`
      : sql`select m.user_id from membership m
             where m.account_id = ${ctx.accountId}
               and m.state = 'active'
               and (m.is_super_admin or m.edit_hubs && ${sql.raw(
                 `ARRAY[${input.to.hubs.map((hub) => `'${hub}'`).join(',')}]::rawr_hub[]`,
               )})`

  await tx.execute(sql`
    insert into notification (account_id, user_id, kind, dedupe_key, title, body, entity, entity_id, actor_id)
    select ${ctx.accountId}, a.user_id, ${input.kind}, ${input.dedupeKey}, ${input.title},
           ${input.body ?? null}, ${input.entity ?? null}, ${input.entityId ?? null}, ${ctx.actorId}
      from (${audience}) a
     where a.user_id is not null
       and (${ctx.actorId}::uuid is null or a.user_id <> ${ctx.actorId}::uuid)
    on conflict (account_id, user_id, dedupe_key) do update
       set count = notification.count + 1,
           at = now(),
           title = excluded.title,
           body = excluded.body,
           read_at = null,
           trashed_at = null`)
}

/** The half nobody remembers to build. A derived count is self-healing; a stored
 *  row is not, so the thing that made a notice true has to say when it stops
 *  being true. Without this the drawer fills with permanently-unread notices
 *  about work that is already done, and people stop reading it. */
export const resolveNotifications = async (
  tx: Tx,
  ctx: AccountContext,
  dedupeKeyPrefix: string,
): Promise<void> => {
  await tx.execute(sql`
    update notification
       set read_at = now()
     where account_id = ${ctx.accountId}
       and read_at is null
       and dedupe_key like ${`${dedupeKeyPrefix}%`}`)
}

export const unreadCount = async (ctx: AccountContext): Promise<number> =>
  withAccount(ctx, async (tx) => {
    if (!ctx.actorId) return 0
    const [row] = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from (
        select 1 from notification
         where account_id = ${ctx.accountId} and user_id = ${ctx.actorId}
           and read_at is null and trashed_at is null
         limit ${BADGE_CAP}
      ) capped`)
    return Number(row?.n ?? 0)
  })

export const listNotifications = async (
  ctx: AccountContext,
  input: { tab: NotificationTab; cursor?: NotificationCursor | null; limit?: number },
): Promise<NotificationPage> =>
  withAccount(ctx, async (tx) => {
    if (!ctx.actorId) return { rows: [], nextCursor: null }
    const limit = Math.min(Math.max(input.limit ?? PAGE, 1), MAX_PAGE)
    const tab =
      input.tab === 'unread'
        ? sql`read_at is null and trashed_at is null`
        : input.tab === 'trash'
          ? sql`trashed_at is not null`
          : sql`trashed_at is null`
    const after = input.cursor
      ? sql`and (at, id) < (${input.cursor.at}::timestamptz, ${input.cursor.id}::uuid)`
      : sql``

    // One more than asked for: whether another page exists is the answer, and a
    // count(*) over the same predicate would be a second scan to learn it.
    const rows = await tx.execute<{
      id: string
      kind: NotificationKind
      title: string
      body: string | null
      entity: string | null
      entity_id: string | null
      count: number
      read_at: string | null
      trashed_at: string | null
      at: string
    }>(sql`
      select id, kind, title, body, count, read_at, trashed_at, at,
             -- A notification outlives the record it is about. It keeps its
             -- sentence, which still reads correctly, and loses the link rather
             -- than offering a page that has been deleted.
             case when ${entityAlive(sql`entity`, sql`entity_id`)} then entity end as entity,
             case when ${entityAlive(sql`entity`, sql`entity_id`)} then entity_id end as entity_id
        from notification
       where account_id = ${ctx.accountId} and user_id = ${ctx.actorId} and ${tab} ${after}
       order by at desc, id desc
       limit ${limit + 1}`)

    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      rows: page.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        entity: row.entity,
        entityId: row.entity_id,
        count: Number(row.count),
        readAt: row.read_at ? new Date(row.read_at) : null,
        trashedAt: row.trashed_at ? new Date(row.trashed_at) : null,
        at: new Date(row.at),
      })),
      nextCursor: rows.length > limit && last ? { at: String(last.at), id: last.id } : null,
    }
  })

/** Each of these scopes on the reader's own id as well as the row id, so a
 *  guessed id belonging to somebody else changes nothing. */
const setOn = async (
  ctx: AccountContext,
  id: string,
  values: Record<string, unknown>,
): Promise<void> => {
  if (!ctx.actorId) return
  await withAccount(ctx, (tx) =>
    tx
      .update(notification)
      .set(values)
      .where(and(eq(notification.id, id), eq(notification.userId, ctx.actorId!))),
  )
}

export const markRead = (ctx: AccountContext, id: string): Promise<void> =>
  setOn(ctx, id, { readAt: new Date() })

export const trashNotification = (ctx: AccountContext, id: string): Promise<void> =>
  setOn(ctx, id, { trashedAt: new Date(), readAt: new Date() })

export const restoreNotification = (ctx: AccountContext, id: string): Promise<void> =>
  setOn(ctx, id, { trashedAt: null })

export const markAllRead = async (ctx: AccountContext): Promise<void> => {
  if (!ctx.actorId) return
  await withAccount(ctx, (tx) =>
    tx
      .update(notification)
      .set({ readAt: new Date() })
      .where(and(eq(notification.userId, ctx.actorId!), isNull(notification.readAt))),
  )
}
