import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { createdAt, pk, updatedAt, accountId } from './columns.ts'
import { importKindEnum, importStateEnum } from './enums.ts'
import { userAccount, account } from './identity.ts'

/** A8. The run outlives the browser tab: an import of 90,000 rows is a server-side
 *  job whose progress and result live on a page the user can leave and come back to. */
export const importRun = pgTable(
  'import_run',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    /** The object's key, not one of three: `object_def` is what says which keys
     *  exist, so a custom object can be imported into. */
    objectType: text('object_type').notNull(),
    /** Records fill columns; activities land on the timeline of the record they
     *  name. An activity run still carries an object type, because the rows are
     *  matched to contacts or companies before they are written. */
    importKind: importKindEnum('import_kind').notNull().default('records'),
    /** Which export this file came out of, so the mapper can offer the preset that
     *  reads it. Null for a file somebody built by hand. */
    source: text('source'),
    filename: text('filename').notNull(),
    /** Header shape plus column count. The mapping of the last run with the same
     *  signature is offered as the default, so the same weekly export is mapped once.
     *  Empty until the file has been read, because an uploaded file's headers are
     *  not known until the server opens it. */
    fileSignature: text('file_signature').notNull(),
    /** Where the file itself is, while it is being read. Null for a run whose rows
     *  were handed over directly, which is what the scripts and the verify suites do. */
    uploadKey: text('upload_key'),
    /** The multipart upload in progress, cleared once storage has the whole object.
     *  Its presence is what says an unfinished upload can still be abandoned. */
    uploadId: text('upload_id'),
    /** What storage has acknowledged, `[{ n, etag, bytes }]` in part order. A part
     *  sent twice is recognised by its number and not uploaded again, which is what
     *  makes an upload resumable after the tab was closed. */
    uploadParts: jsonb('upload_parts').notNull().default([]),
    /** How much of the file is in storage, and how big the file is. Both are
     *  bigint: a 2GB export is four bytes past what an integer holds. */
    uploadedBytes: bigint('uploaded_bytes', { mode: 'number' }).notNull().default(0),
    fileBytes: bigint('file_bytes', { mode: 'number' }).notNull().default(0),
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

/** The file itself, one row per line, kept while the run can still resume and,
 *  after that, only for the rows it refused.
 *
 *  Not a jsonb array on the run: Postgres rewrites a jsonb value whole, so an
 *  88,000-row file re-serialised once per 200-row chunk is quadratic in the
 *  length of the file. Here a chunk reads the slice it is about to write and
 *  writes nothing back. */
export const importRow = pgTable(
  'import_row',
  {
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => importRun.id, { onDelete: 'cascade' }),
    /** The row's place in the file, from zero, so `import_run.processed_rows` is
     *  both the resume cursor and the position of the next row to read. */
    position: integer('position').notNull(),
    /** Header name to cell text, as the file had it, before any mapping. Empty
     *  cells are left out: a HubSpot export is mostly empty columns, and storing
     *  every one of them made a row eighteen times the size of its line in the CSV. */
    values: jsonb('values').notNull(),
    /** Why the run refused this row. A refused row outlives the run so the error
     *  file can hand back every one of them, not the first thousand. */
    reason: text('reason'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.position] })],
)
