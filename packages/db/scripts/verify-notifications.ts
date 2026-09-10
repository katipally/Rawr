import postgres from 'postgres'
import type { AccountContext } from '../src/dal/context.ts'
import { withAccount } from '../src/dal/index.ts'
import {
  listNotifications,
  markAllRead,
  markRead,
  notify,
  resolveNotifications,
  restoreNotification,
  trashNotification,
  unreadCount,
} from '../src/dal/notifications.ts'
import { createTask, deleteTask } from '../src/dal/tasks.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import { SANDBOX, PEER, cleanup } from './fixture.ts'

/** The stored notification model, proved by writing and reading it rather than by
 *  looking at a bell.
 *
 *  A derived badge was self-healing; stored rows are not. Every check here is one
 *  way this table goes wrong quietly: a dedupe key that does not dedupe, a
 *  account that can see another's notices, one person's Mark all as read
 *  clearing somebody else's, retention that deletes the wrong side of a bound, or
 *  the unread query silently starting to sort. */

const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })

const failures: string[] = []
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const contextFor = (accountId: string, actorId: string): AccountContext => ({
  accountId,
  actorId,
  actorKind: 'user',
  isSuperAdmin: true,
  viewHubs: [],
  editHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'],
})

try {
  const [ws] = await owner`select id from account where slug = ${SANDBOX.slug}`
  const [other] = await owner`select id from account where slug = ${PEER.slug}`
  if (!ws || !other) throw new Error('Seed the database first: pnpm db:seed')
  const accountId = ws.id as string
  const otherId = other.id as string

  const people = await owner`
    select u.id, u.name from user_account u
      join membership m on m.user_id = u.id
     where m.account_id = ${accountId}
     order by u.name limit 3`
  if (people.length < 3) throw new Error('This needs three members in datasaur.')
  const [actor, alice, bob] = people.map((row) => row.id as string) as [string, string, string]

  const ctx = contextFor(accountId, actor)
  const aliceCtx = contextFor(accountId, alice)
  const bobCtx = contextFor(accountId, bob)

  // A clean slate for the probe rows only: the seed's own notices stay, because
  // the counts below are all measured as differences.
  const wipe = async () =>
    await owner`delete from notification where dedupe_key like 'verify:%'`
  await wipe()

  // ---------------------------------------------------------------- the table

  const [rls] = await owner`
    select relrowsecurity as enabled, relforcerowsecurity as forced
      from pg_class where oid = 'public.notification'::regclass`
  check(
    rls?.enabled === true && rls?.forced === true,
    'row level security is on and forced',
    'apply_tenancy() picked the table up from its account_id, with no hand-written policy',
  )

  const [granted] = await owner`
    select has_table_privilege('rawr_app', 'public.notification', 'select, insert, update, delete') as ok`
  check(granted?.ok === true, 'rawr_app can read and write the table')

  // ---------------------------------------------------------------- writing

  await withAccount(ctx, (tx) =>
    notify(tx, ctx, {
      kind: 'form_submission',
      dedupeKey: 'verify:one',
      title: 'A lead arrived',
      to: { userIds: [alice, bob] },
    }),
  )
  await withAccount(ctx, (tx) =>
    notify(tx, ctx, {
      kind: 'form_submission',
      dedupeKey: 'verify:one',
      title: 'A lead arrived',
      to: { userIds: [alice, bob] },
    }),
  )

  const deduped = await owner`
    select user_id, count from notification where dedupe_key = 'verify:one' order by user_id`
  check(deduped.length === 2, 'one row per recipient, not one per event', `${deduped.length} rows`)
  check(
    deduped.every((row) => Number(row.count) === 2),
    'the same key twice rolls into one row counting two',
    deduped.map((row) => row.count).join(', '),
  )

  await withAccount(ctx, (tx) =>
    notify(tx, ctx, {
      kind: 'form_submission',
      dedupeKey: 'verify:self',
      title: 'Something you did',
      to: { userIds: [actor, alice] },
    }),
  )
  const [self] = await owner`
    select count(*)::int as n from notification
     where dedupe_key = 'verify:self' and user_id = ${actor}`
  check(self?.n === 0, 'the actor is never told about their own action')

  // ---------------------------------------------------------------- reading

  const aliceUnread = await unreadCount(aliceCtx)
  check(aliceUnread >= 2, 'the badge counts what is addressed to you', `${aliceUnread}`)

  const page = await listNotifications(aliceCtx, { tab: 'unread' })
  check(
    page.rows.every((row) => row.readAt === null && row.trashedAt === null),
    'the unread tab holds nothing read and nothing thrown away',
  )

  // The same person id, pinned to another account. The row is not theirs to see
  // there, which is the tenancy policy doing the work rather than a filter.
  const across = await listNotifications(contextFor(otherId, alice), { tab: 'all' })
  check(
    !across.rows.some((row) => row.title === 'A lead arrived'),
    'another account sees none of it',
  )

  // ------------------------------------------------------------ read state

  const bobBefore = await unreadCount(bobCtx)
  await markAllRead(aliceCtx)
  const bobAfter = await unreadCount(bobCtx)
  check(
    (await unreadCount(aliceCtx)) === 0 && bobAfter === bobBefore,
    'one person clearing their queue leaves everybody else alone',
    `bob ${bobBefore} → ${bobAfter}`,
  )

  // ------------------------------------------------------------ trash

  const bobsRow = (await listNotifications(bobCtx, { tab: 'unread' })).rows[0]
  if (!bobsRow) throw new Error('Bob should have something unread by now.')
  await trashNotification(bobCtx, bobsRow.id)
  const afterTrash = await listNotifications(bobCtx, { tab: 'unread' })
  const inTrash = await listNotifications(bobCtx, { tab: 'trash' })
  check(
    !afterTrash.rows.some((row) => row.id === bobsRow.id) &&
      inTrash.rows.some((row) => row.id === bobsRow.id),
    'throwing one away moves it out of unread and into the trash',
  )
  await restoreNotification(bobCtx, bobsRow.id)
  check(
    (await listNotifications(bobCtx, { tab: 'trash' })).rows.every((row) => row.id !== bobsRow.id),
    'restoring puts it back',
  )

  // ------------------------------------------------------------ resolution

  await withAccount(ctx, (tx) =>
    notify(tx, ctx, {
      kind: 'form_quarantined',
      dedupeKey: 'verify:held:42',
      title: 'One held for review',
      to: { userIds: [alice] },
    }),
  )
  await markRead(aliceCtx, (await listNotifications(aliceCtx, { tab: 'unread' })).rows[0]!.id)
  await withAccount(ctx, (tx) =>
    notify(tx, ctx, {
      kind: 'form_quarantined',
      dedupeKey: 'verify:held:43',
      title: 'Another held for review',
      to: { userIds: [alice] },
    }),
  )
  await withAccount(ctx, (tx) => resolveNotifications(tx, ctx, 'verify:held:'))
  const held = await owner`
    select count(*)::int as n from notification
     where dedupe_key like 'verify:held:%' and read_at is null`
  check(
    held[0]?.n === 0,
    'resolving marks every notice about the resolved thing read',
    'without this the drawer fills with unread notices about work already done',
  )

  // ------------------------------------------------------------ tasks

  const kinds = await owner`
    select enumlabel from pg_enum
     where enumtypid = 'public.rawr_notification_kind'::regtype`
  const kindNames = kinds.map((row) => row.enumlabel as string)
  check(
    kindNames.includes('task_reminder') && kindNames.includes('task_assigned'),
    'the bell knows the two task kinds',
    'blocked until 0069 is applied',
  )

  // Caught rather than thrown so the retention and plan checks below still run
  // on a database where 0070 has not been applied yet.
  try {
  const handed = await createTask(ctx, { title: 'Verify: chase the renewal', assigneeId: alice, dueDate: '2030-01-31' })
  const own = await createTask(ctx, { title: 'Verify: my own errand', assigneeId: actor })

  const [toldAlice] = await owner`
    select count(*)::int as n from notification
     where kind = 'task_assigned' and user_id = ${alice}
       and dedupe_key = ${`task:assigned:${handed.id}:${alice}`}`
  check(
    toldAlice?.n === 1,
    'handing a task to somebody tells them once',
    'a task assigned in silence is work nobody knows they have',
  )

  const [toldSelf] = await owner`
    select count(*)::int as n from notification
     where kind = 'task_assigned' and dedupe_key like ${`task:assigned:${own.id}:%`}`
  check(toldSelf?.n === 0, 'a task you gave yourself tells nobody')

  // The notifications.reminders pass, narrowed to this account so a suite run never
  // writes a notice to a real tenant. Everything else about it is the worker's
  // statement, including the key.
  await owner`
    update task set remind_at = now() - interval '1 hour' where id = ${handed.id}`
  const remindPass = () => owner`
    insert into notification (account_id, user_id, kind, dedupe_key, title, body, entity, entity_id)
    select t.account_id, t.assignee_id, 'task_reminder',
           'task:remind:' || t.id || ':' || extract(epoch from t.remind_at)::bigint,
           'Reminder: ' || t.title,
           case when t.due_date is null then 'No due date.'
                else 'Due ' || to_char(t.due_date, 'FMDay DD FMMonth') || '.' end,
           'task', t.id
      from task t
     where t.account_id = ${accountId}
       and t.status = 'open'
       and t.assignee_id is not null
       and t.remind_at is not null
       and t.remind_at <= now()
    on conflict (account_id, user_id, dedupe_key) do nothing`
  await remindPass()
  await remindPass()

  const reminders = await owner`
    select count, user_id from notification
     where kind = 'task_reminder' and entity_id = ${handed.id}`
  check(
    reminders.length === 1 && Number(reminders[0]?.count) === 1,
    'a reminder that is still due is sent once, not every run',
    'blocked until 0070 is applied; the key carries the instant, so moving it arms it again',
  )
  check(
    reminders[0]?.user_id === alice,
    'and goes to the person the task belongs to, not the one who wrote it',
  )

  await owner`delete from notification where entity_id in (${handed.id}, ${own.id})`
  await deleteTask(ctx, handed.id)
  await deleteTask(ctx, own.id)
  } catch (cause) {
    check(false, 'the task type, queue and reminder columns exist', String(cause))
  }

  // ------------------------------------------------------------ retention

  await owner`
    insert into notification (account_id, user_id, kind, dedupe_key, title, at, trashed_at)
    values (${accountId}, ${alice}, 'form_submission', 'verify:old-trash', 'Old, thrown away',
            now() - interval '40 days', now() - interval '31 days'),
           (${accountId}, ${alice}, 'form_submission', 'verify:new-trash', 'Just thrown away',
            now() - interval '2 days', now() - interval '1 day')`

  await owner`
    delete from notification
     where trashed_at is not null and trashed_at < now() - make_interval(days => 30)`
  const [kept] = await owner`
    select count(*)::int as n from notification where dedupe_key = 'verify:new-trash'`
  const [gone] = await owner`
    select count(*)::int as n from notification where dedupe_key = 'verify:old-trash'`
  check(
    gone?.n === 0 && kept?.n === 1,
    'the trash purge takes what is past the bound and spares what is inside it',
  )

  // ------------------------------------------------------------ the plan

  // Enough rows that the planner has a reason to prefer an index. On a table of
  // twelve it will seq scan whatever exists, and a check that passes only
  // because the table is empty proves nothing about the badge in production.
  await owner`
    insert into notification (account_id, user_id, kind, dedupe_key, title, at)
    select ${accountId}, ${alice}, 'form_submission', 'verify:bulk:' || n,
           'Bulk ' || n, now() - (n || ' minutes')::interval
      from generate_series(1, 5000) as n`
  await owner`analyze notification`

  const plan = await owner`
    explain (format json)
    select id, at from notification
     where account_id = ${accountId} and user_id = ${alice}
       and read_at is null and trashed_at is null
     order by at desc, id desc
     limit 30`
  const planText = JSON.stringify(plan)
  check(
    planText.includes('notification_unread_idx'),
    'the unread query rides its own partial index',
    'a badge that scans is a badge on every page load',
  )
  check(
    !planText.includes('"Node Type":"Sort"'),
    'and needs no sort node',
    'the index order is the query order; a new column in the wrong place would break this quietly',
  )

  await wipe()
} finally {
  await owner.end()
  await closeAppPool()
  await cleanup()
}

console.log(failures.length === 0 ? '\nAll notification checks passed.' : `\n${failures.length} failed.`)
process.exit(failures.length === 0 ? 0 : 1)
