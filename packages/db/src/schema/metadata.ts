import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, pk, accountId } from './columns.ts'
import { fieldStorageEnum, fieldTypeEnum, indexStateEnum } from './enums.ts'
import { account } from './identity.ts'

export const objectDef = pgTable(
  'object_def',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    nameSingular: text('name_singular').notNull(),
    namePlural: text('name_plural').notNull(),
    isCustom: boolean('is_custom').notNull().default(false),
    icon: text('icon'),
    labelFieldId: uuid('label_field_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('object_def_key_key').on(t.accountId, t.key)],
)

/** The single source of truth for list columns, filter operators, sort keys, the
 *  editor component, the CSV rule, the write-path validation and the MCP tool
 *  schema. No surface hardcodes a field list. */
export const fieldDef = pgTable(
  'field_def',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objectDef.id, { onDelete: 'cascade' }),
    /** Generated once, validated against ^[a-z][a-z0-9_]{0,58}$ and a reserved-word
     *  list. A label rename never touches it and never touches data. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: fieldTypeEnum('type').notNull(),
    storage: fieldStorageEnum('storage').notNull(),
    /** Set only when storage is 'column'. The physical column it resolves to. */
    columnName: text('column_name'),
    isCustom: boolean('is_custom').notNull().default(true),
    isRequired: boolean('is_required').notNull().default(false),
    isUnique: boolean('is_unique').notNull().default(false),
    options: jsonb('options'),
    defaultValue: jsonb('default_value'),
    helpText: text('help_text'),
    /** What the property sits under on the settings screen. HubSpot groups its
     *  three hundred and seventy-two, and the group is the only thing that makes
     *  that many navigable. Null means ungrouped, which is where hand-made fields
     *  land until somebody says otherwise. */
    groupName: text('group_name'),
    /** Which import wrote this definition, so a property that arrived from a
     *  portal reads differently from one somebody added here. Null for both. */
    source: text('source'),
    /** One group of conditions over sibling fields, in the shape the filter
     *  builder produces. While it does not match, the property is not on the
     *  record. Null means always shown, which is what a property is. */
    conditional: jsonb('conditional'),
    /** How many records hold a value, as of `filledAt`. Cached because the answer
     *  costs a scan and the screen asks it for every property at once. */
    filledCount: integer('filled_count'),
    filledAt: timestamp('filled_at', { withTimezone: true }),
    position: integer('position').notNull().default(0),
    /** Has a dedicated expression index, created by a job and recorded in field_index. */
    isHot: boolean('is_hot').notNull().default(false),
    /** A3: a field_change activity is written only for fields marked here.
     *  Without the gate an 88,270-row import writes 371 rows per contact. */
    trackChanges: boolean('track_changes').notNull().default(false),
    /** Two-phase delete. Hidden everywhere the moment this is set, data still present
     *  until an explicit purge strips the key from every row. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('field_def_key_key').on(t.accountId, t.objectId, t.key),
    index('field_def_object_idx').on(t.accountId, t.objectId, t.position),
  ],
)

export const fieldIndex = pgTable(
  'field_index',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    fieldId: uuid('field_id')
      .notNull()
      .references(() => fieldDef.id, { onDelete: 'cascade' }),
    pgIndexName: text('pg_index_name').notNull(),
    state: indexStateEnum('state').notNull().default('pending'),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('field_index_name_key').on(t.pgIndexName)],
)
