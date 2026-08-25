import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, pk, workspaceId } from './columns.ts'
import { subscriptionStateEnum, viewKindEnum } from './enums.ts'
import { userAccount, workspace } from './identity.ts'
import { objectDef, fieldDef } from './metadata.ts'
import { contact } from './records.ts'

export const subscriptionType = pgTable(
  'subscription_type',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    isInternal: boolean('is_internal').notNull().default(false),
  },
  (t) => [uniqueIndex('subscription_type_name_key').on(t.workspaceId, t.name)],
)

/** 'unspecified' is a real state that must display as itself, not as a default of
 *  subscribed or unsubscribed. D15. */
export const subscriptionState = pgTable(
  'subscription_state',
  {
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    subscriptionTypeId: uuid('subscription_type_id')
      .notNull()
      .references(() => subscriptionType.id, { onDelete: 'cascade' }),
    state: subscriptionStateEnum('state').notNull().default('unspecified'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source'),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.contactId, t.subscriptionTypeId] })],
)

export const segment = pgTable(
  'segment',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objectDef.id, { onDelete: 'cascade' }),
    query: jsonb('query').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('segment_name_key').on(t.workspaceId, t.name)],
)

/** Entry and exit are kept, not overwritten, because both are timeline events. */
export const segmentMembership = pgTable(
  'segment_membership',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    segmentId: uuid('segment_id')
      .notNull()
      .references(() => segment.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id').notNull(),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    exitedAt: timestamp('exited_at', { withTimezone: true }),
  },
  (t) => [
    index('segment_membership_segment_idx').on(t.workspaceId, t.segmentId, t.entityId),
    index('segment_membership_entity_idx').on(t.workspaceId, t.entityId),
  ],
)

export const savedView = pgTable(
  'saved_view',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objectDef.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The URL segment. /contacts/:workspace/objects/:object/views/:slug/list is
     *  the shareable address of a view, so the slug is the identity, not the uuid. */
    slug: text('slug').notNull(),
    kind: viewKindEnum('kind').notNull().default('table'),
    position: integer('position').notNull().default(0),
    ownerId: uuid('owner_id').references(() => userAccount.id, { onDelete: 'set null' }),
    isShared: boolean('is_shared').notNull().default(false),
    filters: jsonb('filters').notNull().default([]),
    sorts: jsonb('sorts').notNull().default([]),
    columns: jsonb('columns').notNull().default([]),
    groupByFieldId: uuid('group_by_field_id').references(() => fieldDef.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    index('saved_view_object_idx').on(t.workspaceId, t.objectId, t.position),
    uniqueIndex('saved_view_slug_key').on(t.workspaceId, t.objectId, t.slug),
  ],
)
