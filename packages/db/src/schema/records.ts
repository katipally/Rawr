import {
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
import { activityTypeEnum, actorKindEnum, entityTypeEnum } from './enums.ts'
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    search: searchVector('name', 'domain', 'industry', 'city', 'country'),
  },
  (t) => [
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    search: searchVector('first_name', 'last_name', 'email', 'title'),
  },
  (t) => [
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
    payload: jsonb('payload'),
    createdAt: createdAt(),
  },
  (t) => [index('activity_occurred_idx').on(t.workspaceId, t.occurredAt.desc(), t.id.desc())],
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
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.activityId, t.entityType, t.entityId] }),
    index('activity_link_entity_idx').on(t.workspaceId, t.entityType, t.entityId),
  ],
)
