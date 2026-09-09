import { pgEnum } from 'drizzle-orm/pg-core'

/** What HubSpot grants a user, one hub at a time. A membership carries the hubs it
 *  may read and the hubs it may write, so "reads the reports, edits nothing" is a
 *  set of grants rather than a role nobody can extend.
 *
 *  `service` has no screens in Rawr yet. It is here because the members screen
 *  mirrors HubSpot's grid, and a hub missing from the grid reads as a hub the
 *  company does not have rather than one this app has not built. */
export const hubEnum = pgEnum('rawr_hub', [
  'contacts',
  'sales',
  'marketing',
  'service',
  'reports',
  'account',
])

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
  'rich_text',
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

export const viewKindEnum = pgEnum('rawr_view_kind', [
  'table',
  'board',
  /** Placed on days by a date field, which `group_by_field_id` names: a board
   *  points that at a stage, a calendar points it at a date. */
  'calendar',
])

/** Only `import_job.object_type` still holds this. Every other column that points
 *  at a record (a timeline link, an association, a task, a file, an automation
 *  run) is text, because an admin invents objects and an enum cannot be widened
 *  to hold a name nobody has typed yet. Importing into a custom object is not
 *  built, so this column really does hold one of three. */
export const entityTypeEnum = pgEnum('rawr_entity_type', ['company', 'contact', 'deal'])

/** Twenty types, reduced from HubSpot's 44-type filter set to what
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
/** 'collective' is every listed host at once: a panel, or an AE with an SE. It
 *  intersects availability where round robin unions it, so adding a fourth host
 *  makes a page harder to book rather than easier. */
export const bookingKindEnum = pgEnum('rawr_booking_kind', [
  'one_on_one',
  'round_robin',
  'collective',
])

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

/** 'dev' exists for a deployment with no Google project: it reads busy time from Rawr's
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

/** B11. What starts an automation. Every one of these is an event Rawr already
 *  emits on a write, which is why none of them needs a scheduler. */
export const automationTriggerEnum = pgEnum('rawr_automation_trigger', [
  'record_created',
  'stage_changed',
  'lifecycle_changed',
  'form_submitted',
])

/** `skipped` is the interesting one: the automation was armed, the event
 *  happened, and a condition was false. Without it a log of successes cannot say
 *  whether a rule is broken or simply not matching. */
export const automationStateEnum = pgEnum('rawr_automation_state', [
  /** Parked partway through, waiting on a delay. The set of these is the
   *  dispatcher's queue. */
  'waiting',
  'done',
  'skipped',
  'failed',
])

/** What a notification is about. Named rather than free text so a drawer can
 *  group and an icon can be chosen without matching on a title. */
export const notificationKindEnum = pgEnum('rawr_notification_kind', [
  'task_overdue',
  'form_submission',
  'form_quarantined',
  'deal_stage_change',
  'dead_letter',
  'integration_error',
  'mailbox_revoked',
])
