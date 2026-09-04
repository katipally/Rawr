import { pgEnum } from 'drizzle-orm/pg-core'

export const roleEnum = pgEnum('rawr_role', ['admin', 'sales', 'marketing', 'viewer'])

/** An organisation owns workspaces. Two roles only: somebody who can create a
 *  workspace, seat people and end their access, and somebody who is simply in the
 *  organisation. What they may do inside a given workspace is still `rawr_role`. */
export const orgRoleEnum = pgEnum('rawr_org_role', ['org_admin', 'member'])

/** `invited` is a seat held for an address that has not signed in yet;
 *  `deactivated` keeps the row so the audit trail still names a person, while
 *  every membership it carries stops answering. */
export const memberStateEnum = pgEnum('rawr_member_state', ['active', 'invited', 'deactivated'])

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

/** Whether a message's body has been fetched and stored yet. `pending` is the
 *  hydrate queue; `too_large` and `failed` keep the snippet and say why. */
export const bodyStateEnum = pgEnum('rawr_body_state', ['pending', 'stored', 'too_large', 'failed'])

/** Who may read a mailbox's threads. `team` is the default because continuity is
 *  the point: a successor opens a contact and sees the history. `private` is for a
 *  mailbox that carries personal mail nobody else should read. */
export const mailboxVisibilityEnum = pgEnum('rawr_mailbox_visibility', ['team', 'private'])

/** A sequence's own life. `draft` has never sent; `archived` keeps the history
 *  without offering the sequence for new enrollments. */
export const sequenceStateEnum = pgEnum('rawr_sequence_state', ['draft', 'active', 'paused', 'archived'])

/** Who puts the mail on the wire. Gmail is the member's own mailbox; Woodpecker is
 *  for volume Gmail's daily caps cannot carry. */
export const sequenceSenderEnum = pgEnum('rawr_sequence_sender', ['gmail', 'woodpecker'])

/** What a step does. Only `email` sends; the other three make a task for the owner,
 *  which is how a sequence carries the work a person still has to do. */
export const stepKindEnum = pgEnum('rawr_step_kind', ['email', 'call', 'linkedin', 'task'])

/** Where one contact is in one sequence. Every terminal state names why it ended,
 *  because "finished" and "they replied" are different outcomes to a salesperson. */
export const enrollmentStateEnum = pgEnum('rawr_enrollment_state', [
  'active',
  'waiting_task',
  'paused',
  'finished',
  'replied',
  'bounced',
  'unsubscribed',
  'failed',
  'removed',
])

export const sendStateEnum = pgEnum('rawr_send_state', ['sent', 'failed', 'bounced'])

/** Everything that happens to an enrollment, in one ledger. */
export const sequenceEventEnum = pgEnum('rawr_sequence_event', [
  'sent',
  'open',
  'click',
  'reply',
  'bounce',
  'unsubscribe',
  'task_created',
  'task_done',
  'stopped',
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

/** What one file is. Records go into columns on a record and activities onto its
 *  timeline; the other four carry the shape around the records rather than the
 *  records themselves, and a portal exports every one of them separately. */
export const importKindEnum = pgEnum('rawr_import_kind', [
  'records',
  'activities',
  'properties',
  'associations',
  'lists',
  'submissions',
])

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

/** F2 §1. A round robin page fans across hosts; a one-on-one page is one person's
 *  own link. The distinction drives assignment and who may edit the page, so it is
 *  a column rather than "has exactly one host". */
export const bookingKindEnum = pgEnum('rawr_booking_kind', ['one_on_one', 'round_robin'])

export const bookingLocationEnum = pgEnum('rawr_booking_location', [
  'zoom',
  'google_meet',
  'phone',
  'custom',
])

/** 'rescheduled' is the old row, kept so the timeline reads as a move rather than
 *  a cancellation followed by an unrelated booking. F2 §8. */
export const bookingStateEnum = pgEnum('rawr_booking_state', [
  'confirmed',
  'cancelled',
  'rescheduled',
])

/** 'dev' exists because open item 3 has not landed: it reads busy time from Rawr's
 *  own confirmed bookings so the engine is exercisable end to end before a Google
 *  project exists. It is refused in production. */
export const calendarProviderEnum = pgEnum('rawr_calendar_provider', ['google', 'dev'])

/** F4 §3. How Rawr learned that a visitor is a person. Stored rather than
 *  inferred, because a shared browser producing two identifications is a fact
 *  somebody will need to read back. */
export const aliasViaEnum = pgEnum('rawr_alias_via', [
  'form_submission',
  'booking',
  'product_signin',
])

/** F1 phase B. A mailbox stops rather than retrying forever when a grant is
 *  revoked, and the reason is on screen. B2. */
export const mailboxStateEnum = pgEnum('rawr_mailbox_state', [
  'connected',
  'backfilling',
  'revoked',
  'error',
  'paused',
])

export const messageDirectionEnum = pgEnum('rawr_message_direction', ['inbound', 'outbound'])

export const messageRoleEnum = pgEnum('rawr_message_role', ['from', 'to', 'cc'])

/** F6 §4. Where a stored value came from. Enrichment never overwrites 'human'. */
export const fieldSourceEnum = pgEnum('rawr_field_source', [
  'human',
  'import',
  'enrichment',
  'form',
  'booking',
  'product',
])
