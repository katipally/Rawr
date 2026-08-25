import { pgEnum } from 'drizzle-orm/pg-core'

export const roleEnum = pgEnum('rawr_role', ['admin', 'sales', 'marketing', 'viewer'])

/** 'public' is the anonymous visitor acting through the public edge: a form fill, a
 *  consent choice, a booking. It is deliberately not folded into 'integration',
 *  which means a named third party like Brevo or Apollo. The audit log is a
 *  security record, so "a stranger on the internet did this" has to read as itself. */
export const actorKindEnum = pgEnum('rawr_actor_kind', [
  'user',
  'mcp',
  'job',
  'integration',
  'public',
])

export const fieldStorageEnum = pgEnum('rawr_field_storage', ['column', 'jsonb'])

/** The nineteen field types. Each maps to one Postgres type, one JSON shape, one
 *  operator set, one editor, one CSV rule. */
export const fieldTypeEnum = pgEnum('rawr_field_type', [
  'text',
  'long_text',
  'number',
  'currency',
  'percent',
  'boolean',
  'date',
  'datetime',
  'select',
  'multi_select',
  'email',
  'phone',
  'url',
  'linkedin',
  'address',
  'user',
  'relation',
  'rating',
  'json',
])

export const indexStateEnum = pgEnum('rawr_index_state', ['pending', 'building', 'ready', 'failed'])

export const subscriptionStateEnum = pgEnum('rawr_subscription_state', [
  'subscribed',
  'unsubscribed',
  'unspecified',
])

export const viewKindEnum = pgEnum('rawr_view_kind', ['table', 'board'])

export const entityTypeEnum = pgEnum('rawr_entity_type', ['company', 'contact', 'deal'])

/** 01-crm.md A3. Twenty types, reduced from HubSpot's 44-type filter set to what
 *  Rawr will actually produce. Grouped in the order the timeline filter shows them. */
export const activityTypeEnum = pgEnum('rawr_activity_type', [
  'note',
  'call',
  'email',
  'meeting',
  'task',
  'stage_change',
  'lifecycle_change',
  'subscription_change',
  'segment_change',
  'form_submission',
  'booking',
  'field_change',
  'association_change',
  'merge',
  'import',
  'page_view',
  'custom_event',
  'marketing_email',
  'email_tracking',
  'sequence_activity',
  'enrichment',
])

export const integrationStateEnum = pgEnum('rawr_integration_state', [
  'unconfigured',
  'connected',
  'degraded',
  'revoked',
])

export const taskStatusEnum = pgEnum('rawr_task_status', ['open', 'done'])

export const importStateEnum = pgEnum('rawr_import_state', [
  'mapping',
  'previewing',
  'running',
  'done',
  'failed',
  'cancelled',
])

/** F3 §5. Nothing is silently dropped: a rejection is stored with its score and
 *  reasons, so a false positive is recoverable and a real prospect is never lost. */
export const spamStateEnum = pgEnum('rawr_spam_state', [
  'clean',
  'quarantined',
  'confirmed_spam',
  'released',
])
