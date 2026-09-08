import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { pk, accountId } from './columns.ts'
import { notificationKindEnum } from './enums.ts'
import { userAccount, account } from './identity.ts'

/** What the bell has to say, kept rather than recomputed.
 *
 *  A derived count can only ever answer "how many". It cannot say what happened,
 *  when, whether you have already seen it, or that you dealt with it last week —
 *  and Unread, All and Trash each need all four.
 *
 *  One row per person: "read" is a fact about a person, and a shared row cannot
 *  carry two answers. */
export const notification = pgTable(
  'notification',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    kind: notificationKindEnum('kind').notNull(),
    /** What a repeated event compares against, so a nightly overdue sweep does
     *  not say the same thing every morning until the task is done. Composed by
     *  the writer, never random: same event, same key. */
    dedupeKey: text('dedupe_key').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    /** An object key and an id. The path is built at render time from these
     *  rather than stored, so a route that changes does not leave a table full of
     *  dead links. */
    entity: text('entity'),
    entityId: uuid('entity_id'),
    /** Who caused it, so the drawer never tells you that you moved your own deal. */
    actorId: uuid('actor_id').references(() => userAccount.id, { onDelete: 'set null' }),
    /** How many times this same thing happened. A provider failing forty times is
     *  one line saying forty, not forty lines. */
    count: integer('count').notNull().default(1),
    readAt: timestamp('read_at', { withTimezone: true }),
    trashedAt: timestamp('trashed_at', { withTimezone: true }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_dedupe_key').on(t.accountId, t.userId, t.dedupeKey),
    // Each tab is one partial index whose own predicate implies the tab's, so the
    // read is a backward index scan with no sort node.
    index('notification_unread_idx').on(t.accountId, t.userId, t.at.desc()),
    index('notification_all_idx').on(t.accountId, t.userId, t.at.desc()),
    index('notification_trash_idx').on(t.accountId, t.userId, t.trashedAt.desc()),
  ],
)
