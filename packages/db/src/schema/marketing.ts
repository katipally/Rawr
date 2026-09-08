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
import { createdAt, pk, accountId } from './columns.ts'
import { subscriptionStateEnum, viewKindEnum } from './enums.ts'
import { userAccount, account } from './identity.ts'
import { objectDef, fieldDef } from './metadata.ts'
import { contact } from './records.ts'

export const subscriptionType = pgTable(
  'subscription_type',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    isInternal: boolean('is_internal').notNull().default(false),
  },
  (t) => [uniqueIndex('subscription_type_name_key').on(t.accountId, t.name)],
)

/** 'unspecified' is a real state that must display as itself, not as a default of
 *  subscribed or unsubscribed. D15. */
export const subscriptionState = pgTable(
  'subscription_state',
  {
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
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
  (t) => [primaryKey({ columns: [t.accountId, t.contactId, t.subscriptionTypeId] })],
)

export const segment = pgTable(
  'segment',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objectDef.id, { onDelete: 'cascade' }),
    query: jsonb('query').notNull(),
    /** A list imported from somewhere else, whose members are the file's and not
     *  a query's. The evaluator skips these: rebuilding one from an empty query
     *  would empty it. */
    isStatic: boolean('is_static').notNull().default(false),
    /** Null until the first evaluation. The UI says "not evaluated yet" rather
     *  than showing a member count that is really just zero. */
    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('segment_name_key').on(t.accountId, t.name)],
)

/** Entry and exit are kept, not overwritten, because both are timeline events. */
export const segmentMembership = pgTable(
  'segment_membership',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    segmentId: uuid('segment_id')
      .notNull()
      .references(() => segment.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id').notNull(),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    exitedAt: timestamp('exited_at', { withTimezone: true }),
  },
  (t) => [
    index('segment_membership_segment_idx').on(t.accountId, t.segmentId, t.entityId),
    index('segment_membership_entity_idx').on(t.accountId, t.entityId),
  ],
)

export const savedView = pgTable(
  'saved_view',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objectDef.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The URL segment. /contacts/:account/objects/:object/views/:slug/list is
     *  the shareable address of a view, so the slug is the identity, not the uuid. */
    slug: text('slug').notNull(),
    kind: viewKindEnum('kind').notNull().default('table'),
    position: integer('position').notNull().default(0),
    /** A pinned view is a tab above the list; the rest live behind "All views".
     *  Shared rather than per-person, like position, so the tab bar somebody
     *  describes is the tab bar the next person opens. */
    pinned: boolean('pinned').notNull().default(false),
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
    index('saved_view_object_idx').on(t.accountId, t.objectId, t.pinned.desc(), t.position),
    uniqueIndex('saved_view_slug_key').on(t.accountId, t.objectId, t.slug),
  ],
)
