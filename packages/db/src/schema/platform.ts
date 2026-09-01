import { boolean, integer, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, pk, workspaceId } from './columns.ts'
import { fieldSourceEnum, integrationStateEnum } from './enums.ts'
import { workspace } from './identity.ts'

/** Credentials are never stored here. secretRef points at the secrets store, which
 *  is deliberately not the database it protects. */
export const integration = pgTable(
  'integration',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    config: jsonb('config').notNull().default({}),
    secretRef: text('secret_ref'),
    state: integrationStateEnum('state').notNull().default('unconfigured'),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('integration_kind_key').on(t.workspaceId, t.kind)],
)

/** A job that fails without landing a row here is a bug, not an incident. */
export const deadLetter = pgTable(
  'dead_letter',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    integrationId: uuid('integration_id').references(() => integration.id, {
      onDelete: 'set null',
    }),
    jobName: text('job_name').notNull(),
    payload: jsonb('payload').notNull(),
    error: text('error').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    replayedAt: timestamp('replayed_at', { withTimezone: true }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dead_letter_open_idx').on(t.workspaceId, t.replayedAt, t.at.desc())],
)

/** F6 §1. An idempotency key per outbound call, so a retry cannot double-write at
 *  the provider. The response is kept so a replay answers the same thing rather
 *  than sending again. */
export const outboundCall = pgTable(
  'outbound_call',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    integrationId: uuid('integration_id').references(() => integration.id, { onDelete: 'cascade' }),
    /** Derived from what is being sent, never random: a retry must produce the
     *  same key or it is not idempotent. */
    idempotencyKey: text('idempotency_key').notNull(),
    operation: text('operation').notNull(),
    response: jsonb('response'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('outbound_call_key').on(t.workspaceId, t.idempotencyKey)],
)

/** F6 §1. Inbound webhooks, deduplicated on the provider's own event id. A webhook
 *  that arrives twice is processed once. */
export const inboundEvent = pgTable(
  'inbound_event',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    /** Null when nothing matched. F6 §3: an event for an unknown address is kept
     *  and surfaced, never dropped. */
    contactId: uuid('contact_id'),
    matched: boolean('matched').notNull().default(false),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('inbound_event_key').on(t.workspaceId, t.source, t.providerEventId),
    index('inbound_event_unmatched_idx').on(t.workspaceId, t.matched, t.at.desc()),
  ],
)

/** F6 §4. Where a value came from. The rule that matters: enrichment never
 *  overwrites something a human typed. It fills blanks and updates values whose
 *  provenance is itself enrichment. */
export const fieldSource = pgTable(
  'field_source',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    fieldKey: text('field_key').notNull(),
    source: fieldSourceEnum('source').notNull(),
    /** Which provider, when the source is enrichment. */
    provider: text('provider'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('field_source_key').on(t.workspaceId, t.entity, t.entityId, t.fieldKey)],
)

/** F6 §4. What enrichment suggested but was not allowed to write, so a human can
 *  look at it and decide. "Not written" must not mean "never seen". */
export const enrichmentSuggestion = pgTable(
  'enrichment_suggestion',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    fieldKey: text('field_key').notNull(),
    suggested: text('suggested').notNull(),
    current: text('current'),
    provider: text('provider').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('enrichment_suggestion_key').on(t.workspaceId, t.entity, t.entityId, t.fieldKey),
    index('enrichment_suggestion_entity_idx').on(t.workspaceId, t.entity, t.entityId),
  ],
)
