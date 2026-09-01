import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, pk, workspaceId } from './columns.ts'
import { mailboxStateEnum, messageDirectionEnum, messageRoleEnum } from './enums.ts'
import { userAccount, workspace } from './identity.ts'
import { contact } from './records.ts'

/** F1 phase B. Gmail, read only.
 *
 *  Trevor's continuity requirement: a successor opens a contact and sees the whole
 *  email history without anybody having forwarded anything. Rawr never sends mail
 *  and builds no tracking pixel; opens and clicks are bought from Apollo and land
 *  as a different activity type. D7, D8. */

export const mailbox = pgTable(
  'mailbox',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    state: mailboxStateEnum('state').notNull().default('connected'),
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
    createdAt: createdAt(),
  },
  (t) => [
    // One mailbox per person per workspace. Connecting twice re-authorises rather
    // than producing a second cursor over the same messages.
    uniqueIndex('mailbox_user_key').on(t.workspaceId, t.userId),
    index('mailbox_state_idx').on(t.workspaceId, t.state),
  ],
)

export const messageThread = pgTable(
  'message_thread',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('gmail'),
    providerThreadId: text('provider_thread_id').notNull(),
    subject: text('subject'),
    firstAt: timestamp('first_at', { withTimezone: true }),
    lastAt: timestamp('last_at', { withTimezone: true }),
    messageCount: integer('message_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    // One thread per provider thread per workspace, whichever mailbox saw it. Two
    // colleagues on the same thread store it once. B's edge-case table.
    uniqueIndex('message_thread_provider_key').on(t.workspaceId, t.provider, t.providerThreadId),
    index('message_thread_last_idx').on(t.workspaceId, t.lastAt),
  ],
)

export const message = pgTable(
  'message',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
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
    /** Object storage key, prefixed by workspace_id. Never the body itself: a
     *  20MB thread must not bloat the table. B1. */
    bodyRef: text('body_ref'),
    hasAttachments: boolean('has_attachments').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    // What makes the back-fill resumable with no duplicates. B2.
    uniqueIndex('message_provider_key').on(t.workspaceId, t.providerMessageId),
    index('message_thread_idx').on(t.workspaceId, t.threadId, t.sentAt),
  ],
)

export const messageParticipant = pgTable(
  'message_participant',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
    role: messageRoleEnum('role').notNull(),
  },
  (t) => [
    uniqueIndex('message_participant_key').on(t.workspaceId, t.messageId, t.address, t.role),
    index('message_participant_contact_idx').on(t.workspaceId, t.contactId),
  ],
)

/** Addresses and domains that never enter the CRM. Applied at ingest, so a blocked
 *  thread is never stored rather than stored and hidden. B3. */
export const messageBlocklist = pgTable(
  'message_blocklist',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    /** Null means the whole workspace. Set means one person's own exclusions,
     *  which they control themselves. */
    userId: uuid('user_id').references(() => userAccount.id, { onDelete: 'cascade' }),
    /** An address, or a domain with no local part. Stored lowercase. */
    pattern: text('pattern').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('message_blocklist_key').on(t.workspaceId, t.userId, t.pattern)],
)
