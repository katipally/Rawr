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
import { createdAt, pk, updatedAt, workspaceId } from './columns.ts'
import {
  enrollmentStateEnum,
  sendStateEnum,
  sequenceEventEnum,
  sequenceSenderEnum,
  sequenceStateEnum,
  stepKindEnum,
} from './enums.ts'
import { userAccount, workspace } from './identity.ts'
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
}

export const sequence = pgTable(
  'sequence',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
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
  (t) => [uniqueIndex('sequence_workspace_name_key').on(t.workspaceId, t.name)],
)

export const sequenceStep = pgTable(
  'sequence_step',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
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
    bodyHtml: text('body_html'),
    bodyText: text('body_text'),
    taskTitle: text('task_title'),
    taskBody: text('task_body'),
  },
  (t) => [index('sequence_step_order_idx').on(t.workspaceId, t.sequenceId, t.position)],
)

export const sequenceEnrollment = pgTable(
  'sequence_enrollment',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
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
      .on(t.workspaceId, t.nextRunAt)
      .where(sql`state = 'active'`),
    index('sequence_enrollment_contact_idx').on(t.workspaceId, t.contactId),
    index('sequence_enrollment_sequence_idx').on(t.workspaceId, t.sequenceId, t.state),
  ],
)

export const sequenceSend = pgTable(
  'sequence_send',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
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
    openCount: integer('open_count').notNull().default(0),
    clickCount: integer('click_count').notNull().default(0),
    firstOpenedAt: timestamp('first_opened_at', { withTimezone: true }),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
  },
  (t) => [
    // What the daily cap counts, per mailbox per day.
    index('sequence_send_mailbox_idx').on(t.workspaceId, t.mailboxId, t.sentAt),
    index('sequence_send_enrollment_idx').on(t.workspaceId, t.enrollmentId),
    index('sequence_send_internet_id_idx').on(t.workspaceId, t.internetMessageId),
  ],
)

/** Every link in a sent mail, addressed by a token. The redirect looks the URL up
 *  here rather than taking one from the request, so the endpoint cannot be used as
 *  an open redirect. */
export const sequenceLink = pgTable(
  'sequence_link',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    sendId: uuid('send_id')
      .notNull()
      .references(() => sequenceSend.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    url: text('url').notNull(),
    clickCount: integer('click_count').notNull().default(0),
  },
  (t) => [index('sequence_link_send_idx').on(t.workspaceId, t.sendId)],
)

export const sequenceEvent = pgTable(
  'sequence_event',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    enrollmentId: uuid('enrollment_id')
      .notNull()
      .references(() => sequenceEnrollment.id, { onDelete: 'cascade' }),
    sendId: uuid('send_id').references(() => sequenceSend.id, { onDelete: 'set null' }),
    kind: sequenceEventEnum('kind').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    detail: jsonb('detail'),
  },
  (t) => [index('sequence_event_enrollment_idx').on(t.workspaceId, t.enrollmentId, t.at)],
)
