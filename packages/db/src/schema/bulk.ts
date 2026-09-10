import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { accountId, createdAt, pk, updatedAt } from './columns.ts'
import { account, userAccount } from './identity.ts'

/** A bulk bar action too large to finish inside one request.
 *
 *  Under the inline threshold the bar does the work and shows the result. Above
 *  it the selection is written here and the worker asks the app for one chunk at
 *  a time, the way an import runs, so closing the tab stops nothing. */
export const bulkOperation = pgTable(
  'bulk_operation',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    /** delete | assign | associate | add_to_list. */
    kind: text('kind').notNull(),
    objectKey: text('object_key').notNull(),
    ids: uuid('ids').array().notNull(),
    /** What the action needs beyond the selection: the owner, the record to link
     *  to, the list to add to. */
    config: jsonb('config').notNull().default({}),
    state: text('state').notNull().default('running'),
    total: integer('total').notNull(),
    /** Progress and resume cursor at once: the next chunk starts here. */
    processed: integer('processed').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    errors: jsonb('errors').notNull().default([]),
    lastError: text('last_error'),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('bulk_operation_recent_idx').on(t.accountId, t.createdAt.desc())],
)
