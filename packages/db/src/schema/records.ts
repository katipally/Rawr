import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, pk, searchVector, updatedAt, workspaceId } from './columns.ts'
import { activityTypeEnum, actorKindEnum, entityTypeEnum, taskStatusEnum } from './enums.ts'
import { userAccount, workspace } from './identity.ts'

export const lifecycleStage = pgTable(
  'lifecycle_stage',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('lifecycle_stage_name_key').on(t.workspaceId, t.name)],
)

export const company = pgTable(
  'company',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name'),
    domain: text('domain'),
    industry: text('industry'),
    city: text('city'),
    country: text('country'),
    phone: text('phone'),
    employeeCount: integer('employee_count'),
    annualRevenue: numeric('annual_revenue', { precision: 18, scale: 2 }),
    ownerId: uuid('owner_id').references(() => userAccount.id, { onDelete: 'set null' }),
    lifecycleStageId: uuid('lifecycle_stage_id').references(() => lifecycleStage.id, {
      onDelete: 'set null',
    }),
    /** D17: kept verbatim so a future ad platform needs no backfill. */
    originalSource: jsonb('original_source'),
    latestSource: jsonb('latest_source'),
    custom: jsonb('custom').notNull().default({}),
    /** F6. The provider's own id for this record, keyed by provider, so a sync
     *  is incremental rather than a full re-push and an opt-out can be sent to
     *  the right row at the other end. */
    externalIds: jsonb('external_ids').notNull().default({}),
    /** Soft delete. Activity is retained and its timeline entry reads "deleted
     *  company", so history is never silently rewritten. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    search: searchVector('name', 'domain', 'industry', 'city', 'country'),
  },
  (t) => [
    /** Dedupe enforced by the index, not by check-then-insert, so two concurrent
     *  imports cannot both win. Partial, so soft-deleted rows free their domain. */
    uniqueIndex('company_domain_key')
      .on(t.workspaceId, t.domain)
      .where(sql`domain is not null and deleted_at is null`),
    index('company_search_idx').using('gin', t.search),
    index('company_custom_idx').using('gin', t.custom),
    index('company_owner_idx').on(t.workspaceId, t.ownerId),
    index('company_domain_idx').on(t.workspaceId, t.domain),
    index('company_created_idx').on(t.workspaceId, t.createdAt.desc(), t.id.desc()),
  ],
)

export const contact = pgTable(
  'contact',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    firstName: text('first_name'),
    lastName: text('last_name'),
    email: text('email'),
    phone: text('phone'),
    title: text('title'),
    linkedinUrl: text('linkedin_url'),
    companyId: uuid('company_id').references(() => company.id, { onDelete: 'set null' }),
    ownerId: uuid('owner_id').references(() => userAccount.id, { onDelete: 'set null' }),
    lifecycleStageId: uuid('lifecycle_stage_id').references(() => lifecycleStage.id, {
      onDelete: 'set null',
    }),
    leadStatus: text('lead_status'),
    leadSource: text('lead_source'),
    /** HubSpot's Marketing Contact Status. Shape parity is a design constraint, D9. */
    marketingStatus: text('marketing_status'),
    originalSource: jsonb('original_source'),
    latestSource: jsonb('latest_source'),
    custom: jsonb('custom').notNull().default({}),
    /** F6. The provider's own id for this record, keyed by provider, so a sync
     *  is incremental rather than a full re-push and an opt-out can be sent to
     *  the right row at the other end. */
    externalIds: jsonb('external_ids').notNull().default({}),
    /** Email engagement, derived. See dal/engagement.ts. */
    lastContactedAt: timestamp('last_contacted_at', { withTimezone: true }),
    lastRepliedAt: timestamp('last_replied_at', { withTimezone: true }),
    emailsSent: integer('emails_sent').notNull().default(0),
    emailsReceived: integer('emails_received').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    search: searchVector('first_name', 'last_name', 'email', 'title'),
  },
  (t) => [
    uniqueIndex('contact_email_key')
      .on(t.workspaceId, sql`lower(${t.email})`)
      .where(sql`email is not null and deleted_at is null`),
    index('contact_search_idx').using('gin', t.search),
    index('contact_custom_idx').using('gin', t.custom),
    index('contact_company_idx').on(t.workspaceId, t.companyId),
    index('contact_owner_idx').on(t.workspaceId, t.ownerId),
    index('contact_created_idx').on(t.workspaceId, t.createdAt.desc(), t.id.desc()),
  ],
)

export const pipeline = pgTable(
  'pipeline',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('pipeline_name_key').on(t.workspaceId, t.name)],
)

export const pipelineStage = pgTable(
  'pipeline_stage',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipeline.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    probability: numeric('probability', { precision: 5, scale: 2 }),
    position: integer('position').notNull().default(0),
    isClosedWon: boolean('is_closed_won').notNull().default(false),
    isClosedLost: boolean('is_closed_lost').notNull().default(false),
  },
  (t) => [index('pipeline_stage_pipeline_idx').on(t.workspaceId, t.pipelineId, t.position)],
)

export const deal = pgTable(
  'deal',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name'),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipeline.id, { onDelete: 'restrict' }),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => pipelineStage.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 18, scale: 2 }),
    currency: text('currency').notNull().default('USD'),
    closeDate: date('close_date'),
    nextStep: text('next_step'),
    nextStepDate: date('next_step_date'),
    ownerId: uuid('owner_id').references(() => userAccount.id, { onDelete: 'set null' }),
    companyId: uuid('company_id').references(() => company.id, { onDelete: 'set null' }),
    dealType: text('deal_type'),
    originalSource: jsonb('original_source'),
    latestSource: jsonb('latest_source'),
    custom: jsonb('custom').notNull().default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    search: searchVector('name', 'next_step', 'deal_type'),
  },
  (t) => [
    index('deal_search_idx').using('gin', t.search),
    index('deal_custom_idx').using('gin', t.custom),
    index('deal_stage_idx').on(t.workspaceId, t.stageId, t.closeDate),
    index('deal_owner_idx').on(t.workspaceId, t.ownerId),
    index('deal_created_idx').on(t.workspaceId, t.createdAt.desc(), t.id.desc()),
  ],
)

/** Many-to-many between any two record types, with HubSpot's optional label. */
export const association = pgTable(
  'association',
  {
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    fromType: entityTypeEnum('from_type').notNull(),
    fromId: uuid('from_id').notNull(),
    toType: entityTypeEnum('to_type').notNull(),
    toId: uuid('to_id').notNull(),
    label: text('label'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.fromType, t.fromId, t.toType, t.toId] }),
    index('association_reverse_idx').on(t.workspaceId, t.toType, t.toId),
  ],
)

export const activity = pgTable(
  'activity',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    type: activityTypeEnum('type').notNull(),
    subject: text('subject'),
    body: text('body'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    actorId: uuid('actor_id'),
    actorKind: actorKindEnum('actor_kind').notNull(),
    source: text('source'),
    /** What this row was in the file it was imported from. Unique per workspace, so
     *  re-importing the same HubSpot export leaves the timeline as it was rather
     *  than writing every note a second time. Null for anything Rawr wrote itself. */
    importKey: text('import_key'),
    payload: jsonb('payload'),
    createdAt: createdAt(),
  },
  (t) => [
    index('activity_occurred_idx').on(t.workspaceId, t.occurredAt.desc(), t.id.desc()),
    uniqueIndex('activity_import_key_idx').on(t.workspaceId, t.importKey).where(sql`import_key is not null`),
  ],
)

/** One activity can hang on several records, which is how an email thread appears
 *  on the contact, the company and the deal without being stored three times. */
export const activityLink = pgTable(
  'activity_link',
  {
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    activityId: uuid('activity_id')
      .notNull()
      .references(() => activity.id, { onDelete: 'cascade' }),
    entityType: entityTypeEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    /** Copied from the activity, written in the same transaction. A contact with
     *  4,000 activities is keyset paginated and counted straight off the index
     *  below; without these two columns every page would sort a join result. */
    type: activityTypeEnum('type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.activityId, t.entityType, t.entityId] }),
    /** The foreign key's own index. Every other index here leads with
     *  workspace_id, which serves the timeline read and cannot serve the cascade
     *  from activity: without this, deleting one activity scans the whole table. */
    index('activity_link_activity_idx').on(t.activityId),
    index('activity_link_timeline_idx').on(
      t.workspaceId,
      t.entityType,
      t.entityId,
      t.occurredAt.desc(),
      t.activityId.desc(),
    ),
    index('activity_link_type_idx').on(t.workspaceId, t.entityType, t.entityId, t.type),
  ],
)

/** A9. One task hangs on at most one record, which is how HubSpot's task queue
 *  behaves and is all Trevor's Monday chase needs. */
export const task = pgTable(
  'task',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body'),
    dueDate: date('due_date'),
    status: taskStatusEnum('status').notNull().default('open'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    assigneeId: uuid('assignee_id').references(() => userAccount.id, { onDelete: 'set null' }),
    entityType: entityTypeEnum('entity_type'),
    entityId: uuid('entity_id'),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('task_queue_idx').on(t.workspaceId, t.status, t.dueDate, t.id),
    index('task_assignee_idx').on(t.workspaceId, t.assigneeId, t.status, t.dueDate),
    index('task_entity_idx').on(t.workspaceId, t.entityType, t.entityId),
  ],
)

/** A file on a record.
 *
 *  The bytes live in object storage; this names one and says who put it there. A
 *  database is the wrong place for a forty megabyte PDF, and keeping one there
 *  would put it in every backup and replica of the rows people actually query.
 *
 *  `message_attachment` is a different thing and stays separate: that one belongs
 *  to an email and arrived with it. This one somebody chose to put on a deal. */
export const attachment = pgTable(
  'attachment',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    /** Not a foreign key: the type decides which of three tables it points at,
     *  and no constraint spans them. The shape activityLink already uses. */
    entityType: entityTypeEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    /** The path inside the bucket, carrying the workspace, so one tenant's prefix
     *  is never another's even if a bucket is ever shared or misconfigured. */
    storageKey: text('storage_key').notNull(),
    filename: text('filename').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    mime: text('mime').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => userAccount.id, { onDelete: 'set null' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('attachment_entity_idx').on(t.workspaceId, t.entityType, t.entityId, t.at.desc()),
    /** An upload retried writes the same key, and without this the record would
     *  show the same file twice. */
    uniqueIndex('attachment_storage_key').on(t.workspaceId, t.storageKey),
  ],
)
