import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, pk, accountId } from './columns.ts'
import {
  bodyStateEnum,
  mailboxStateEnum,
  mailboxVisibilityEnum,
  messageDirectionEnum,
  messageRoleEnum,
} from './enums.ts'
import { userAccount, account } from './identity.ts'
import { contact } from './records.ts'

/** Gmail. Read for history, and, once a mailbox is reconnected with the send
 *  scope, write for sequences and one-off replies.
 *
 *  The continuity requirement: a successor opens a contact and sees the whole
 *  email history without anybody having forwarded anything. That is why bodies are
 *  stored here rather than fetched from the owner's mailbox on demand: the moment
 *  somebody leaves and their grant is revoked, an on-demand read returns nothing
 *  and the history a colleague relies on is gone. */

export const mailbox = pgTable(
  'mailbox',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    state: mailboxStateEnum('state').notNull().default('connected'),
    /** Who may read the threads this mailbox brought in. */
    visibility: mailboxVisibilityEnum('visibility').notNull().default('team'),
    /** Encrypted with a key held outside this database. F0 §8. */
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    /** Gmail's incremental cursor. A 404 on this triggers a full re-list. B2. */
    historyId: text('history_id'),
    /** Where the oldest-first back-fill got to. Null once it has finished. */
    backfillCursor: text('backfill_cursor'),
    backfillDone: boolean('backfill_done').notNull().default(false),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    /** True once the mailbox has been reconnected with the send scope. False by
     *  default, so an existing read-only grant cannot start sending because a
     *  sequence asked it to. */
    canSend: boolean('can_send').notNull().default(false),
    /** Google's own limits are per account, so the pacing is too. */
    dailyCap: integer('daily_cap').notNull().default(100),
    /** Overrides the sequence's window for this mailbox, when somebody wants
     *  their own mail sent on their own hours. */
    sendWindow: jsonb('send_window').$type<{ days: number[]; start: string; end: string; timezone: string }>(),
    minGapSeconds: integer('min_gap_seconds').notNull().default(45),
    /** Off by default: a sequence of two hundred sends would otherwise fill one
     *  person's bell with two hundred notices they never asked for. */
    alertOnOpen: boolean('alert_on_open').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    // One mailbox per person per account. Connecting twice re-authorises rather
    // than producing a second cursor over the same messages.
    uniqueIndex('mailbox_user_key').on(t.accountId, t.userId),
    index('mailbox_state_idx').on(t.accountId, t.state),
  ],
)

export const messageThread = pgTable(
  'message_thread',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('gmail'),
    providerThreadId: text('provider_thread_id').notNull(),
    subject: text('subject'),
    firstAt: timestamp('first_at', { withTimezone: true }),
    lastAt: timestamp('last_at', { withTimezone: true }),
    messageCount: integer('message_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    // One thread per provider thread per account, whichever mailbox saw it. Two
    // colleagues on the same thread store it once. B's edge-case table.
    uniqueIndex('message_thread_provider_key').on(t.accountId, t.provider, t.providerThreadId),
    index('message_thread_last_idx').on(t.accountId, t.lastAt),
  ],
)

export const message = pgTable(
  'message',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => messageThread.id, { onDelete: 'cascade' }),
    providerMessageId: text('provider_message_id').notNull(),
    direction: messageDirectionEnum('direction').notNull(),
    fromAddr: text('from_addr'),
    toAddrs: text('to_addrs').array().notNull().default([]),
    ccAddrs: text('cc_addrs').array().notNull().default([]),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    snippet: text('snippet'),
    /** RFC 5322 threading. What a reply is matched against, and what a sequence
     *  sets so its own reply lands in the same conversation. */
    internetMessageId: text('internet_message_id'),
    inReplyTo: text('in_reply_to'),
    references: text('references').array().notNull().default([]),
    /** Whether the body has been fetched. The row is stored first and hydrated
     *  after, so a slow or rate-limited fetch never costs the message itself. */
    bodyState: bodyStateEnum('body_state').notNull().default('pending'),
    bodyError: text('body_error'),
    hasAttachments: boolean('has_attachments').notNull().default(false),
    /** The mailbox that read it. A Gmail message id only means something inside
     *  the mailbox that issued it, so fetching the body later needs this. */
    mailboxId: uuid('mailbox_id').references(() => mailbox.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    // What makes the back-fill resumable with no duplicates. B2.
    uniqueIndex('message_provider_key').on(t.accountId, t.providerMessageId),
    index('message_thread_idx').on(t.accountId, t.threadId, t.sentAt),
    index('message_internet_id_idx').on(t.accountId, t.internetMessageId),
  ],
)

/** The body, in its own table. `message` is scanned by the inbox and the record
 *  page, and a wide row full of a 2MB HTML mail makes every one of those scans
 *  read pages it does not need; Postgres would TOAST the value anyway, so this is
 *  the same storage with an honest name and a narrow parent. */
export const messageBody = pgTable('message_body', {
  id: pk(),
  accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
  messageId: uuid('message_id')
    .notNull()
    .unique()
    .references(() => message.id, { onDelete: 'cascade' }),
  textBody: text('text_body').notNull(),
  /** Sanitised before it is stored, and rendered inside a sandboxed frame with
   *  images blocked until asked for. Null when it was too large or absent. */
  htmlBody: text('html_body'),
  textBytes: integer('text_bytes').notNull().default(0),
  htmlBytes: integer('html_bytes').notNull().default(0),
  truncated: boolean('truncated').notNull().default(false),
  storedAt: timestamp('stored_at', { withTimezone: true }).notNull().defaultNow(),
})

/** What was attached, not the bytes. A list is what a reader needs; fetching one
 *  goes back to Gmail while a mailbox that can still do so exists. */
export const messageAttachment = pgTable(
  'message_attachment',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    providerAttachmentId: text('provider_attachment_id'),
    /** An inline image referenced by the HTML rather than a real attachment. */
    inline: boolean('inline').notNull().default(false),
  },
  (t) => [index('message_attachment_message_idx').on(t.accountId, t.messageId)],
)

/** How far each person has read each thread. Per person, because "unread" is not
 *  a property of a shared thread. */
export const messageThreadRead = pgTable(
  'message_thread_read',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => messageThread.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('message_thread_read_key').on(t.accountId, t.threadId, t.userId)],
)

export const messageParticipant = pgTable(
  'message_participant',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
    role: messageRoleEnum('role').notNull(),
  },
  (t) => [
    uniqueIndex('message_participant_key').on(t.accountId, t.messageId, t.address, t.role),
    index('message_participant_contact_idx').on(t.accountId, t.contactId),
  ],
)

/** Addresses and domains that never enter the CRM. Applied at ingest, so a blocked
 *  thread is never stored rather than stored and hidden. B3. */
export const messageBlocklist = pgTable(
  'message_blocklist',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    /** Null means the whole account. Set means one person's own exclusions,
     *  which they control themselves. */
    userId: uuid('user_id').references(() => userAccount.id, { onDelete: 'cascade' }),
    /** An address, or a domain with no local part. Stored lowercase. */
    pattern: text('pattern').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('message_blocklist_key').on(t.accountId, t.userId, t.pattern)],
)
