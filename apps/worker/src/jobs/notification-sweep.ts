import { z } from 'zod'
import { owner } from '../db.ts'
import { defineJob } from './registry.ts'

/** The two things a stored notification needs that no write path can do.
 *
 *  First, the one notice with no event behind it: a task does not become overdue,
 *  it simply stops not being. Somebody has to notice, each morning of the account's
 *  own timezone.
 *
 *  Second, a bound. Every other table here is bounded by what people create; this
 *  one is bounded by what happens, which is unbounded. Four rules rather than one
 *  because "old" means something different for a notice you never opened than for
 *  one you threw away.
 *
 *  A reminder is neither: the person picked an instant, so it belongs on its own
 *  short cycle rather than on a pass tuned to run once, overnight. */

/** Trash is an undo window, not an archive. */
const TRASHED_DAYS = 30
const READ_DAYS = 90
/** Telling somebody at seven is telling them before they start rather than during. */
const MORNING_HOUR = 7
/** An unread notice about a task from six months ago is noise, and leaving it
 *  makes the badge permanently non-zero, which is how a badge stops being read.
 *
 *  The sweep deletes an unread notice this old, so the overdue notifier only
 *  notices tasks due within this many days. Past that, the next morning would
 *  notice the same task again and the deleted notice would come back. Inclusive:
 *  a task due exactly this many days ago is still noticed on the last day of the
 *  window, and its first notice is only swept the day after. */
const UNREAD_DAYS = 180
/** The backstop that actually holds if a dedupe key is ever composed wrong. */
const KEEP_PER_PERSON = 500
/** Batched so a delete never holds a long lock on a table the app reads on every
 *  page. */
const BATCH = 10_000

/** Hourly rather than daily, because the morning is the account's and a cron
 *  string has one timezone. From seven local on, an account's tasks that are past
 *  due get their notice; the key carries the due date, so the later passes of the
 *  same day and a worker that slept through seven are both no-ops. One statement
 *  across every account, from the owner pool: the assignee is the recipient, so
 *  there is no per-account fan-out. Rides task_queue_idx rather than scanning task. */
export const notificationOverdue = defineJob({
  name: 'notifications.overdue',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 300,
  audience: 'select id as account_id from account',
  handle: async () => {
    const [made] = await owner`
      insert into notification (account_id, user_id, kind, dedupe_key, title, body, entity, entity_id)
      select t.account_id, t.assignee_id, 'task_overdue',
             'task:overdue:' || t.id || ':' || t.due_date,
             t.title || ' is overdue',
             'Was due ' || to_char(t.due_date, 'FMDay DD FMMonth') || '.',
             'task', t.id
        from task t
        join account a on a.id = t.account_id
       where t.status = 'open'
         and t.assignee_id is not null
         and t.due_date is not null
         and t.due_date < (now() at time zone a.timezone)::date
         and t.due_date >= (now() at time zone a.timezone)::date - ${UNREAD_DAYS}::int
         and extract(hour from now() at time zone a.timezone) >= ${MORNING_HOUR}::int
      on conflict (account_id, user_id, dedupe_key) do nothing
      returning 1`.then((rows) => [rows.length])

    if (made) console.log(`[notifications] ${made} overdue notices.`)
  },
})

export const notificationSweep = defineJob({
  name: 'notifications.sweep',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 300,
  policy: 'exclusive',
  audience: 'select id as account_id from account',
  handle: async () => {
    let removed = 0
    for (const rule of [
      owner`delete from notification where ctid in (
              select ctid from notification
               where trashed_at is not null and trashed_at < now() - make_interval(days => ${TRASHED_DAYS})
               limit ${BATCH})`,
      owner`delete from notification where ctid in (
              select ctid from notification
               where read_at is not null and at < now() - make_interval(days => ${READ_DAYS})
               limit ${BATCH})`,
      owner`delete from notification where ctid in (
              select ctid from notification
               where read_at is null and at < now() - make_interval(days => ${UNREAD_DAYS})
               limit ${BATCH})`,
      owner`delete from notification where ctid in (
              select ctid from (
                select ctid, row_number() over (partition by account_id, user_id order by at desc) as rank
                  from notification
              ) ranked
               where ranked.rank > ${KEEP_PER_PERSON}
               limit ${BATCH})`,
    ]) {
      const result = await rule
      removed += result.count ?? 0
    }

    console.log(`[notifications] ${removed} rows retired.`)
  },
})

/** Every quarter hour, so a reminder set for a time is delivered near it. The key
 *  carries the instant, so moving a reminder arms it again and leaving one alone
 *  never says it twice, and re-running inside the same quarter hour is a no-op.
 *  Rides task_remind_idx. */
export const notificationReminders = defineJob({
  name: 'notifications.reminders',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 60,
  audience: 'select id as account_id from account',
  handle: async () => {
    const sent = await owner`
      insert into notification (account_id, user_id, kind, dedupe_key, title, body, entity, entity_id)
      select t.account_id, t.assignee_id, 'task_reminder',
             'task:remind:' || t.id || ':' || extract(epoch from t.remind_at)::bigint,
             'Reminder: ' || t.title,
             case when t.due_date is null then 'No due date.'
                  else 'Due ' || to_char(t.due_date, 'FMDay DD FMMonth') || '.' end,
             'task', t.id
        from task t
       where t.status = 'open'
         and t.assignee_id is not null
         and t.remind_at is not null
         and t.remind_at <= now()
      on conflict (account_id, user_id, dedupe_key) do nothing
      returning 1`

    if (sent.length > 0) console.log(`[notifications] ${sent.length} reminders.`)
  },
})
