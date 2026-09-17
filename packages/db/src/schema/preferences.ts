import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { accountId, pk } from './columns.ts'
import { account, userAccount } from './identity.ts'

/** What used to live only in this browser's localStorage: the rail's width,
 *  bookmarks, recent navigation, a timeline filter, a collapsed panel. None of it
 *  followed a person to another machine, and all of it leaked between accounts on
 *  a shared browser, because nothing scoped it by who was asking.
 *
 *  One row per (account, person, key) rather than one table per preference: the
 *  set of preferences grows as screens do, and a table added for each would be a
 *  migration for every one. `getPrefs` still reads the whole set in a single
 *  query, since the unique index is exactly that lookup's shape. */
export const preference = pgTable(
  'preference',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('preference_scope_key_idx').on(t.accountId, t.userId, t.key)],
)
