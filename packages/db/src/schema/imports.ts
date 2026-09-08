import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { createdAt, pk, updatedAt, accountId } from './columns.ts'
import { entityTypeEnum, importKindEnum, importStateEnum } from './enums.ts'
import { userAccount, account } from './identity.ts'

/** A8. The run outlives the browser tab: an import of 90,000 rows is a server-side
 *  job whose progress and result live on a page the user can leave and come back to. */
export const importRun = pgTable(
  'import_run',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    objectType: entityTypeEnum('object_type').notNull(),
    /** Records fill columns; activities land on the timeline of the record they
     *  name. An activity run still carries an object type, because the rows are
     *  matched to contacts or companies before they are written. */
    importKind: importKindEnum('import_kind').notNull().default('records'),
    /** Which export this file came out of, so the mapper can offer the preset that
     *  reads it. Null for a file somebody built by hand. */
    source: text('source'),
    filename: text('filename').notNull(),
    /** Header shape plus column count. The mapping of the last run with the same
     *  signature is offered as the default, so the same weekly export is mapped once. */
    fileSignature: text('file_signature').notNull(),
    /** The column names in the order the file had them. Recovering them from the
     *  stored rows does not work: jsonb does not preserve key order, so the mapper
     *  would list a person's columns in an order they never chose. */
    headers: jsonb('headers').notNull().default([]),
    mapping: jsonb('mapping').notNull().default({}),
    state: importStateEnum('state').notNull().default('mapping'),
    totalRows: integer('total_rows').notNull().default(0),
    /** The resume point. A killed run continues from here rather than restarting. */
    processedRows: integer('processed_rows').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    erroredCount: integer('errored_count').notNull().default(0),
    /** Rows are held here for the duration of the run so a resume needs no re-upload. */
    rows: jsonb('rows'),
    errors: jsonb('errors').notNull().default([]),
    /** B9. Owner names in the file that match nobody here. Those rows land
     *  unassigned rather than failing, so the migration is reconciled from this
     *  list rather than from eighty-eight thousand identical errors. */
    unmatchedOwners: jsonb('unmatched_owners').notNull().default([]),
    lastError: text('last_error'),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('import_run_recent_idx').on(t.accountId, t.createdAt.desc()),
    index('import_run_signature_idx').on(t.accountId, t.fileSignature, t.createdAt.desc()),
  ],
)
