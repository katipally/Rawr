import { pgEnum } from 'drizzle-orm/pg-core'

export const roleEnum = pgEnum('rawr_role', ['admin', 'sales', 'marketing', 'viewer'])

export const actorKindEnum = pgEnum('rawr_actor_kind', ['user', 'mcp', 'job', 'integration'])

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
])

export const integrationStateEnum = pgEnum('rawr_integration_state', [
  'unconfigured',
  'connected',
  'degraded',
  'revoked',
])
