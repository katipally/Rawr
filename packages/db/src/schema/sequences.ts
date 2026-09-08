import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, pk, updatedAt, accountId } from './columns.ts'
import {
  enrollmentStateEnum,
  sendStateEnum,
  sequenceEventEnum,
  sequenceSenderEnum,
  sequenceStateEnum,
  stepKindEnum,
} from './enums.ts'
import { userAccount, account } from './identity.ts'
import { mailbox, message, messageThread } from './messaging.ts'
import { contact, task } from './records.ts'

/** Sequences, sent from the member's own Gmail rather than bought from Apollo.
 *
 *  The reason to own this: a sequence that sends from a salesperson's mailbox
 *  lands in the same thread as the rest of the conversation, is stored here like
 *  every other message, and stops the moment somebody replies, because the reply
 *  arrives through the same sync. A third party doing the sending knows none of
 *  that. */

/** What a sequence decides once, rather than per step. */
export type SequenceSettings = {
  /** Days 1-5 are Monday to Friday, matching Postgres `isodow`. */
  sendWindow: { days: number[]; start: string; end: string; timezone: string }
  stopOnReply: boolean
  stopOnBounce: boolean
  stopOnUnsubscribe: boolean
  trackOpens: boolean
  trackClicks: boolean
  /** Which opt-out a recipient's unsubscribe applies to. */
  subscriptionTypeId: string | null
  /** Send each step as a reply on the first message's thread, so the recipient
   *  sees one conversation rather than five unrelated mails. */
  replyInThread: boolean
  /** Only for a Woodpecker sequence, where the steps and the cadence live in
   *  Woodpecker's campaign rather than here. Null until one is picked. */
  woodpeckerCampaignId: number | null
}

export const sequence = pgTable(
  'sequence',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    state: sequenceStateEnum('state').notNull().default('draft'),
    ownerId: uuid('owner_id').references(() => userAccount.id, { onDelete: 'set null' }),
    sender: sequenceSenderEnum('sender').notNull().default('gmail'),
    settings: jsonb('settings').$type<SequenceSettings>().notNull(),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('sequence_account_name_key').on(t.accountId, t.name)],
)

export const sequenceStep = pgTable(
  'sequence_step',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    sequenceId: uuid('sequence_id')
      .notNull()
      .references(() => sequence.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: stepKindEnum('kind').notNull().default('email'),
    /** Wait after the previous step, before this one runs. Zero on the first step
     *  means "as soon as the window allows". */
    delayDays: integer('delay_days').notNull().default(0),
    delayHours: integer('delay_hours').notNull().default(0),
    subject: text('subject'),
    /** A second subject to test against the first. Null means no test, which is
     *  what every step is until somebody types one. Only the subject: two whole
     *  bodies doubles what a reader must hold in their head to know what a
     *  sequence says. */
    subjectB: text('subject_b'),
    bodyHtml: text('body_html'),
    bodyText: text('body_text'),
    taskTitle: text('task_title'),
    taskBody: text('task_body'),
  },
  (t) => [index('sequence_step_order_idx').on(t.accountId, t.sequenceId, t.position)],
)

export const sequenceEnrollment = pgTable(
  'sequence_enrollment',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    sequenceId: uuid('sequence_id')
      .notNull()
      .references(() => sequence.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    /** Whose mailbox sends it. The enrollment is pinned to one, so every step in a
     *  conversation comes from the same person. */
    mailboxId: uuid('mailbox_id').references(() => mailbox.id, { onDelete: 'set null' }),
    enrolledBy: uuid('enrolled_by').references(() => userAccount.id, { onDelete: 'set null' }),
    state: enrollmentStateEnum('state').notNull().default('active'),
    /** How many steps have run. The next one to run is at this position. */
    currentStep: integer('current_step').notNull().default(0),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    /** The conversation every later step replies into. */
    threadId: uuid('thread_id').references(() => messageThread.id, { onDelete: 'set null' }),
    rootInternetMessageId: text('root_internet_message_id'),
    waitingTaskId: uuid('waiting_task_id').references(() => task.id, { onDelete: 'set null' }),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    stopReason: text('stop_reason'),
    /** In every mail this enrollment sends. One token per enrollment, so an
     *  unsubscribe names the sequence it came from. */
    unsubscribeToken: text('unsubscribe_token').notNull().unique(),
    /** Held while a run is in flight, so two workers cannot send the same step. */
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // The scheduler's index. Partial, so it is the size of the queue rather than
    // of every enrollment that ever ran.
    index('sequence_enrollment_due_idx')
      .on(t.accountId, t.nextRunAt)
      .where(sql`state = 'active'`),
    index('sequence_enrollment_contact_idx').on(t.accountId, t.contactId),
    index('sequence_enrollment_sequence_idx').on(t.accountId, t.sequenceId, t.state),
  ],
)

export const sequenceSend = pgTable(
  'sequence_send',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    enrollmentId: uuid('enrollment_id')
      .notNull()
      .references(() => sequenceEnrollment.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id').references(() => sequenceStep.id, { onDelete: 'set null' }),
    mailboxId: uuid('mailbox_id').references(() => mailbox.id, { onDelete: 'set null' }),
    /** The stored copy of what was sent, once the sync reads it back. */
    messageId: uuid('message_id').references(() => message.id, { onDelete: 'set null' }),
    providerMessageId: text('provider_message_id'),
    internetMessageId: text('internet_message_id'),
    /** What the tracking pixel is addressed by. Never the send id: an id in a URL
     *  that also identifies a row is a way to enumerate rows. */
    token: text('token').notNull().unique(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    state: sendStateEnum('state').notNull().default('sent'),
    error: text('error'),
    /** Which subject went out, when the step was testing two. Stored rather than
     *  recomputed, so a step edited later cannot rewrite what was sent. */
    variant: text('variant'),
    openCount: integer('open_count').notNull().default(0),
    clickCount: integer('click_count').notNull().default(0),
    firstOpenedAt: timestamp('first_opened_at', { withTimezone: true }),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
  },
  (t) => [
    // What the daily cap counts, per mailbox per day.
    index('sequence_send_mailbox_idx').on(t.accountId, t.mailboxId, t.sentAt),
    index('sequence_send_enrollment_idx').on(t.accountId, t.enrollmentId),
    index('sequence_send_internet_id_idx').on(t.accountId, t.internetMessageId),
  ],
)

/** Every link in a sent mail, addressed by a token. The redirect looks the URL up
 *  here rather than taking one from the request, so the endpoint cannot be used as
 *  an open redirect. */
export const sequenceLink = pgTable(
  'sequence_link',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    sendId: uuid('send_id')
      .notNull()
      .references(() => sequenceSend.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    url: text('url').notNull(),
    clickCount: integer('click_count').notNull().default(0),
  },
  (t) => [index('sequence_link_send_idx').on(t.accountId, t.sendId)],
)

export const sequenceEvent = pgTable(
  'sequence_event',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    enrollmentId: uuid('enrollment_id')
      .notNull()
      .references(() => sequenceEnrollment.id, { onDelete: 'cascade' }),
    sendId: uuid('send_id').references(() => sequenceSend.id, { onDelete: 'set null' }),
    kind: sequenceEventEnum('kind').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    detail: jsonb('detail'),
  },
  (t) => [index('sequence_event_enrollment_idx').on(t.accountId, t.enrollmentId, t.at)],
)

/** A reusable email. Not a sequence step: this is what somebody drops into one,
 *  or into a one-off reply, so the same twelve sentences are not retyped slightly
 *  differently by four people.
 *
 *  The body is Markdown, the characters the writer typed. The HTML a recipient
 *  gets is rendered from it at send time, which is why the preview in the app and
 *  the mail on the wire cannot drift apart. */
export const emailTemplate = pgTable(
  'email_template',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    subject: text('subject').notNull().default(''),
    bodyText: text('body_text').notNull().default(''),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Two templates called "Intro" is how somebody picks the wrong one.
    uniqueIndex('email_template_name_key').on(t.accountId, sql`lower(${t.name})`),
    index('email_template_recent_idx').on(t.accountId, t.updatedAt),
  ],
)
