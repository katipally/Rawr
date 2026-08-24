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
import { createdAt, pk, workspaceId } from './columns.ts'
import { fieldStorageEnum, fieldTypeEnum, indexStateEnum } from './enums.ts'
import { workspace } from './identity.ts'

export const objectDef = pgTable(
  'object_def',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    nameSingular: text('name_singular').notNull(),
    namePlural: text('name_plural').notNull(),
    isCustom: boolean('is_custom').notNull().default(false),
    icon: text('icon'),
    labelFieldId: uuid('label_field_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('object_def_key_key').on(t.workspaceId, t.key)],
)

/** The single source of truth for list columns, filter operators, sort keys, the
 *  editor component, the CSV rule, the write-path validation and the MCP tool
 *  schema. No surface hardcodes a field list. */
export const fieldDef = pgTable(
  'field_def',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
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
    position: integer('position').notNull().default(0),
    /** Has a dedicated expression index, created by a job and recorded in field_index. */
    isHot: boolean('is_hot').notNull().default(false),
    /** Two-phase delete. Hidden everywhere the moment this is set, data still present
     *  until an explicit purge strips the key from every row. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('field_def_key_key').on(t.workspaceId, t.objectId, t.key),
    index('field_def_object_idx').on(t.workspaceId, t.objectId, t.position),
  ],
)

export const fieldIndex = pgTable(
  'field_index',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
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
