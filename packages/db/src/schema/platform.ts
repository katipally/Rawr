import { boolean, integer, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, pk, updatedAt, accountId } from './columns.ts'
import { fieldSourceEnum, integrationStateEnum } from './enums.ts'
import { userAccount, account } from './identity.ts'

/** Credentials are never stored here. secretRef points at the secrets store, which
 *  is deliberately not the database it protects.
 *
 *  One connection per kind per account: a Slack bot token or a Brevo key is issued
 *  to the company, and the company is the account. */
export const integration = pgTable(
  'integration',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    config: jsonb('config').notNull().default({}),
    secretRef: text('secret_ref'),
    state: integrationStateEnum('state').notNull().default('unconfigured'),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    /** Who connected it, for the Connected Apps table. Null for anything a job
     *  connected. */
    installedBy: uuid('installed_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('integration_kind_key').on(t.accountId, t.kind)],
)

/** A job that fails without landing a row here is a bug, not an incident. */
export const deadLetter = pgTable(
  'dead_letter',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    integrationId: uuid('integration_id').references(() => integration.id, {
      onDelete: 'set null',
    }),
    jobName: text('job_name').notNull(),
    payload: jsonb('payload').notNull(),
    error: text('error').notNull(),
    /** Null for a failure that was never a queued job: nothing was tried, so
     *  nought attempts would be a lie. The failed-jobs table reads it as
     *  "not queued". */
    attempts: integer('attempts'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    replayedAt: timestamp('replayed_at', { withTimezone: true }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dead_letter_open_idx').on(t.accountId, t.replayedAt, t.at.desc())],
)

/** F6 §1. An idempotency key per outbound call, so a retry cannot double-write at
 *  the provider. The response is kept so a replay answers the same thing rather
 *  than sending again. */
export const outboundCall = pgTable(
  'outbound_call',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    integrationId: uuid('integration_id').references(() => integration.id, { onDelete: 'set null' }),
    /** Derived from what is being sent, never random: a retry must produce the
     *  same key or it is not idempotent. */
    idempotencyKey: text('idempotency_key').notNull(),
    operation: text('operation').notNull(),
    response: jsonb('response'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('outbound_call_key').on(t.accountId, t.idempotencyKey)],
)

/** F6 §1. Inbound webhooks, deduplicated on the provider's own event id. A webhook
 *  that arrives twice is processed once. */
export const inboundEvent = pgTable(
  'inbound_event',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
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
    uniqueIndex('inbound_event_key').on(t.accountId, t.source, t.providerEventId),
    index('inbound_event_unmatched_idx').on(t.accountId, t.matched, t.at.desc()),
  ],
)

/** F6 §4. Where a value came from. The rule that matters: enrichment never
 *  overwrites something a human typed. It fills blanks and updates values whose
 *  provenance is itself enrichment. */
export const fieldSource = pgTable(
  'field_source',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    fieldKey: text('field_key').notNull(),
    source: fieldSourceEnum('source').notNull(),
    /** Which provider, when the source is enrichment. */
    provider: text('provider'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('field_source_key').on(t.accountId, t.entity, t.entityId, t.fieldKey)],
)

/** F6 §4. What enrichment suggested but was not allowed to write, so a human can
 *  look at it and decide. "Not written" must not mean "never seen". */
export const enrichmentSuggestion = pgTable(
  'enrichment_suggestion',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    fieldKey: text('field_key').notNull(),
    suggested: text('suggested').notNull(),
    current: text('current'),
    provider: text('provider').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('enrichment_suggestion_key').on(t.accountId, t.entity, t.entityId, t.fieldKey),
    index('enrichment_suggestion_entity_idx').on(t.accountId, t.entity, t.entityId),
  ],
)

/** A record that has just gained a match key, waiting for the worker to ask the
 *  app to enrich it. One row per record, deleted as it is claimed, so the table
 *  holds only what has not run yet. Written by the data layer on every path that
 *  gives a contact an email or a company a domain, and drained only once somebody
 *  has approved the batch: credits are spent on purpose or not at all. */
export const enrichmentRequest = pgTable(
  'enrichment_request',
  {
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null until a person has seen how many records are waiting and accepted
     *  the credit cost. The dispatcher only ever sees approved rows. */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.entity, t.entityId] }),
    index('enrichment_request_approved_idx').on(t.approvedAt),
    index('enrichment_request_waiting_idx').on(t.accountId, t.requestedAt),
  ],
)

/** Who is subscribed to what happens in Rawr.
 *
 *  The mirror of `inbound_event`, and mostly the same machinery pointed outward:
 *  a delivery is a pg-boss job, so its retries, its backoff and its landing in
 *  `dead_letter` on a final failure are the ones every other job already has, and
 *  replaying one is the Failed jobs screen that already exists.
 *
 *  What is here is only the part that is genuinely new: who to tell, and the key
 *  that proves a delivery came from us. */
export const webhookEndpoint = pgTable(
  'webhook_endpoint',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** https only, checked in the layer. A signature proves who sent a payload,
     *  not that nobody else read it. */
    url: text('url').notNull(),
    /** Shown once, when created or rolled. A secret a screen can redisplay is a
     *  secret in a screenshot. */
    secret: text('secret').notNull(),
    /** Event names this one wants. Empty means all of them, which is what piping
     *  Rawr into a warehouse actually wants and saves re-editing the list every
     *  time an event is added. */
    events: jsonb('events').notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('webhook_endpoint_live_idx').on(t.accountId, t.isActive)],
)
