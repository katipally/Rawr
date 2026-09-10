import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  mailbox,
  message,
  messageAttachment,
  messageBlocklist,
  messageBody,
  messageParticipant,
  messageThread,
  messageThreadRead,
} from '../schema/messaging.ts'
import { company, contact } from '../schema/records.ts'
import { userAccount } from '../schema/identity.ts'
import { linksForContacts, recordActivity, type EmailPayload } from './activity.ts'
import { detectReply, isDeliveryReport } from './sequences.ts'
import { isAdmin, type AccountContext } from './context.ts'
import { assertCanWrite } from './context.ts'
import { employerDomainFromEmail, registrableDomain } from './domains.ts'
import { requestEnrichment } from './enrichment.ts'
import { decryptToken, encryptToken } from '../internal/crypto.ts'
import { refreshEmailEngagement } from './engagement.ts'
import { mutate, withAccount, writeAudit, type Tx } from './index.ts'

/** F1 phase B, the storage half. The Gmail calls live in the app; everything that
 *  decides what is kept, who it belongs to and what is refused lives here. */

export type MailboxState = 'connected' | 'backfilling' | 'revoked' | 'error' | 'paused'

/** What `mail.connectDev` stores instead of a Google token. Lives here because
 *  the stored token is encrypted, so only this layer can tell a stand-in from a
 *  real grant. */
export const DEV_ACCESS_TOKEN = 'dev-access'

export type MailboxRow = {
  id: string
  userId: string
  userName: string
  email: string
  state: MailboxState
  historyId: string | null
  backfillDone: boolean
  backfillCursor: string | null
  lastSyncAt: Date | null
  lastError: string | null
  lastErrorAt: Date | null
  threadCount: number
  /** A stand-in mailbox reads fixtures and sends nowhere. The settings page has
   *  to say so: a green "Connected" on a mailbox that is not one is how somebody
   *  spends a week believing their mail is syncing. */
  standIn: boolean
  visibility: 'team' | 'private'
  /** True once it has been reconnected with the send scope. Until then it reads
   *  and cannot send, whatever a sequence asks of it. */
  canSend: boolean
  dailyCap: number
  minGapSeconds: number
}

export const listMailboxes = async (ctx: AccountContext): Promise<MailboxRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: mailbox.id,
        userId: mailbox.userId,
        userName: userAccount.name,
        email: mailbox.email,
        state: mailbox.state,
        visibility: mailbox.visibility,
        canSend: mailbox.canSend,
        dailyCap: mailbox.dailyCap,
        minGapSeconds: mailbox.minGapSeconds,
        historyId: mailbox.historyId,
        accessToken: mailbox.accessToken,
        backfillDone: mailbox.backfillDone,
        backfillCursor: mailbox.backfillCursor,
        lastSyncAt: mailbox.lastSyncAt,
        lastError: mailbox.lastError,
        lastErrorAt: mailbox.lastErrorAt,
      })
      .from(mailbox)
      .innerJoin(userAccount, eq(userAccount.id, mailbox.userId))
      .orderBy(asc(userAccount.name))

    const [counts] = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from message_thread`,
    )
    // One number for the account: threads are shared across mailboxes by design,
    // so "how many threads has this mailbox contributed" is not a thing worth
    // counting twice.
    return rows.map(({ accessToken, ...row }) => ({
      ...row,
      threadCount: Number(counts?.n ?? 0),
      standIn: decryptToken(accessToken) === DEV_ACCESS_TOKEN,
    }))
  })

export type SaveMailboxInput = {
  userId: string
  email: string
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: Date | null
  /** What Google actually granted, not what was asked for. Absent means read
   *  only, which is what a mailbox connected before sending existed had. */
  canSend?: boolean | undefined
}

/** Connecting twice re-authorises rather than starting a second cursor over the
 *  same messages. The back-fill state is deliberately preserved: reconnecting a
 *  mailbox that had already read four years of history must not read it again. */
export const saveMailbox = async (ctx: AccountContext, input: SaveMailboxInput): Promise<{ id: string }> =>
  mutate(ctx, 'mailbox', async (tx) => {
    const [saved] = await tx
      .insert(mailbox)
      .values({
        accountId: ctx.accountId,
        userId: input.userId,
        email: input.email.toLowerCase(),
        state: 'backfilling',
        accessToken: encryptToken(input.accessToken),
        refreshToken: encryptToken(input.refreshToken),
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        canSend: input.canSend ?? false,
        visibility: 'team',
        lastError: null,
        lastErrorAt: null,
      })
      .onConflictDoUpdate({
        target: [mailbox.accountId, mailbox.userId],
        set: {
          email: input.email.toLowerCase(),
          accessToken: encryptToken(input.accessToken),
          refreshToken: encryptToken(input.refreshToken),
          accessTokenExpiresAt: input.accessTokenExpiresAt,
          state: 'backfilling',
          // Reconnecting without the send scope takes sending away again, which
          // is what somebody unticking it on the consent screen meant.
          canSend: input.canSend ?? false,
          lastError: null,
          lastErrorAt: null,
        },
      })
      .returning({ id: mailbox.id })
    if (!saved) throw new Error('The mailbox could not be stored.')

    return {
      result: { id: saved.id },
      audit: {
        entity: 'mailbox',
        entityId: saved.id,
        action: 'connect',
        before: null,
        after: { email: input.email, scope: input.canSend ? 'gmail.readonly + gmail.send' : 'gmail.readonly' },
      },
    }
  })

export type MailboxTokens = {
  id: string
  userId: string
  email: string
  state: MailboxState
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: Date | null
  historyId: string | null
  backfillCursor: string | null
  backfillDone: boolean
  /** Whether this grant may send, so a caller about to send can say why not
   *  before it builds a message nobody can put on the wire. */
  canSend: boolean
}

/** Decrypted only here, only for a sync run. */
export const readMailbox = async (
  ctx: AccountContext,
  mailboxId: string,
): Promise<MailboxTokens | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.select().from(mailbox).where(eq(mailbox.id, mailboxId)).limit(1)
    if (!row) return null
    return {
      id: row.id,
      userId: row.userId,
      email: row.email,
      state: row.state,
      accessToken: decryptToken(row.accessToken),
      refreshToken: decryptToken(row.refreshToken),
      accessTokenExpiresAt: row.accessTokenExpiresAt,
      historyId: row.historyId,
      backfillCursor: row.backfillCursor,
      backfillDone: row.backfillDone,
      canSend: row.canSend,
    }
  })

export const updateMailboxCursor = async (
  ctx: AccountContext,
  mailboxId: string,
  patch: {
    historyId?: string | null
    backfillCursor?: string | null
    backfillDone?: boolean
    state?: MailboxState
    accessToken?: string
    accessTokenExpiresAt?: Date | null
  },
): Promise<void> => {
  await withAccount(ctx, async (tx) => {
    await tx
      .update(mailbox)
      .set({
        ...(patch.historyId !== undefined ? { historyId: patch.historyId } : {}),
        ...(patch.backfillCursor !== undefined ? { backfillCursor: patch.backfillCursor } : {}),
        ...(patch.backfillDone !== undefined ? { backfillDone: patch.backfillDone } : {}),
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.accessToken !== undefined ? { accessToken: encryptToken(patch.accessToken) } : {}),
        ...(patch.accessTokenExpiresAt !== undefined
          ? { accessTokenExpiresAt: patch.accessTokenExpiresAt }
          : {}),
        lastSyncAt: new Date(),
        ...(patch.state === 'connected' ? { lastError: null, lastErrorAt: null } : {}),
      })
      .where(eq(mailbox.id, mailboxId))
  })
}

/** Revocation stops the sync and says so. It never retries in a loop: a revoked
 *  grant does not come back on its own, and hammering Google would be the wrong
 *  answer to somebody having withdrawn consent. B2. */
export const recordMailboxFailure = async (
  ctx: AccountContext,
  mailboxId: string,
  error: string,
  revoked: boolean,
): Promise<void> => {
  await withAccount(ctx, async (tx) => {
    await tx
      .update(mailbox)
      .set({
        state: revoked ? 'revoked' : 'error',
        lastError: error.slice(0, 2000),
        lastErrorAt: new Date(),
      })
      .where(eq(mailbox.id, mailboxId))
  })
}

const STOPPED_BY_DISCONNECT =
  'The mailbox this enrollment was sending from was disconnected. Nothing can go out from an enrollment with no sender, so it is stopped rather than left in the queue. Enroll the contact again from a connected mailbox.'

export const disconnectMailbox = async (ctx: AccountContext, mailboxId: string): Promise<void> =>
  mutate(ctx, 'mailbox', async (tx) => {
    const [found] = await tx
      .select({ email: mailbox.email, userId: mailbox.userId })
      .from(mailbox)
      .where(eq(mailbox.id, mailboxId))
      .limit(1)
    if (!found) throw new Error('That mailbox is not connected.')
    if (!isAdmin(ctx) && found.userId !== ctx.actorId) {
      throw new Error('That is somebody else’s mailbox. Only they, or an admin, can disconnect it.')
    }

    // Before the mailbox goes: every live enrollment sending from it. The
    // foreign key would only null the column, and an enrollment with no mailbox
    // is one the scheduler picks up every minute and can never send. Same
    // transaction, so there is no window in which one exists.
    const [stopped] = await tx.execute<{ count: number }>(sql`
      with ended as (
        update sequence_enrollment
           set state = 'failed', stop_reason = ${STOPPED_BY_DISCONNECT},
               next_run_at = null, finished_at = now(), lease_until = null
         where mailbox_id = ${mailboxId}::uuid
           and state in ('active', 'waiting_task', 'paused')
        returning id
      ), noted as (
        insert into sequence_event (account_id, enrollment_id, kind, detail)
        select ${ctx.accountId}::uuid, id, 'stopped',
               ${JSON.stringify({ state: 'failed', reason: STOPPED_BY_DISCONNECT })}::jsonb
          from ended
      )
      select count(*)::int as count from ended`)

    // The messages already read stay. They are the history the feature exists for,
    // and disconnecting is "stop reading new mail", not "erase what you have read".
    await tx.delete(mailbox).where(eq(mailbox.id, mailboxId))

    return {
      result: undefined,
      audit: {
        entity: 'mailbox',
        entityId: mailboxId,
        action: 'disconnect',
        before: { email: found.email },
        after: { messagesKept: true, enrollmentsStopped: Number(stopped?.count ?? 0) },
      },
    }
  })

// ------------------------------------------------------------- blocklist

export type BlocklistRow = { id: string; pattern: string; note: string | null; userId: string | null }

export const listBlocklist = async (ctx: AccountContext): Promise<BlocklistRow[]> =>
  withAccount(ctx, (tx) =>
    tx
      .select({
        id: messageBlocklist.id,
        pattern: messageBlocklist.pattern,
        note: messageBlocklist.note,
        userId: messageBlocklist.userId,
      })
      .from(messageBlocklist)
      .where(
        isAdmin(ctx)
          ? undefined
          : or(isNull(messageBlocklist.userId), eq(messageBlocklist.userId, ctx.actorId ?? '')),
      )
      .orderBy(asc(messageBlocklist.pattern)),
  )

export const addBlocklistEntry = async (
  ctx: AccountContext,
  input: { pattern: string; note?: string | null; scope: 'account' | 'mine' },
): Promise<{ id: string }> =>
  mutate(ctx, 'message_blocklist', async (tx) => {
    const pattern = input.pattern.trim().toLowerCase()
    if (!pattern || pattern.includes(' ')) {
      throw new Error('A blocklist entry is one address or one domain, with no spaces.')
    }
    if (input.scope === 'account' && !isAdmin(ctx)) {
      throw new Error('Only an admin sets an account-wide exclusion. Add it to your own list instead.')
    }

    const [created] = await tx
      .insert(messageBlocklist)
      .values({
        accountId: ctx.accountId,
        userId: input.scope === 'mine' ? ctx.actorId : null,
        pattern,
        note: input.note?.trim() || null,
      })
      .onConflictDoNothing()
      .returning({ id: messageBlocklist.id })
    if (!created) throw new Error(`"${pattern}" is already on that list.`)

    return {
      result: { id: created.id },
      audit: {
        entity: 'message_blocklist',
        entityId: created.id,
        action: 'create',
        before: null,
        after: { pattern, scope: input.scope },
      },
    }
  })

export const removeBlocklistEntry = async (ctx: AccountContext, id: string): Promise<void> =>
  mutate(ctx, 'message_blocklist', async (tx) => {
    const [found] = await tx
      .select({ pattern: messageBlocklist.pattern, userId: messageBlocklist.userId })
      .from(messageBlocklist)
      .where(eq(messageBlocklist.id, id))
      .limit(1)
    if (!found) throw new Error('That exclusion no longer exists.')
    if (found.userId === null && !isAdmin(ctx)) {
      throw new Error('That is an account exclusion. Only an admin removes one.')
    }
    if (found.userId !== null && found.userId !== ctx.actorId && !isAdmin(ctx)) {
      throw new Error('That exclusion belongs to somebody else.')
    }

    await tx.delete(messageBlocklist).where(eq(messageBlocklist.id, id))
    return {
      result: undefined,
      audit: { entity: 'message_blocklist', entityId: id, action: 'delete', before: found, after: null },
    }
  })

// ------------------------------------------------------------ the ingest

export type IncomingAttachment = {
  filename: string
  mimeType: string | null
  sizeBytes: number
  providerAttachmentId: string | null
  inline: boolean
}

export type IncomingMessage = {
  providerThreadId: string
  providerMessageId: string
  subject: string | null
  from: string
  to: string[]
  cc: string[]
  sentAt: Date
  snippet: string | null
  /** RFC 5322 threading headers. Absent on a row read before B3, which is why
   *  reply matching falls back to the thread. */
  internetMessageId?: string | null | undefined
  inReplyTo?: string | null | undefined
  references?: string[] | undefined
  /** The body, when the fetch that read the headers also read it. Absent leaves
   *  the message `pending` for the hydrate job. */
  body?: MessageBodyInput | null | undefined
  /** Lower-cased header names, for the checks that need more than the five fields
   *  above: an auto-reply is not a reply, and must not stop a sequence. */
  headers?: Record<string, string | undefined> | undefined
  attachments?: IncomingAttachment[] | undefined
  hasAttachments: boolean
}

/** Caps. Text is what a person reads and what search would index, so it survives
 *  truncation; HTML is presentation and is dropped whole rather than cut, because
 *  half a document renders as garbage. */
export const TEXT_LIMIT_BYTES = 1_000_000
export const HTML_LIMIT_BYTES = 2_000_000

export type MessageBodyInput = { text: string; html?: string | null | undefined }

const bytes = (value: string): number => new TextEncoder().encode(value).length

/** Stores one body under the caps. Text is cut and flagged; HTML is dropped whole
 *  rather than cut, because half a document renders as garbage. Both are already
 *  sanitised by the caller: nothing here trusts what a stranger sent. */
export const writeBody = async (
  tx: Tx,
  ctx: AccountContext,
  messageId: string,
  body: MessageBodyInput,
): Promise<void> => {
  const textBytes = bytes(body.text)
  const truncated = textBytes > TEXT_LIMIT_BYTES
  // Cutting by code unit could split a multi-byte character; the encoder is what
  // knows where the limit really falls, so cut and re-measure.
  const text = truncated ? body.text.slice(0, TEXT_LIMIT_BYTES / 4) : body.text
  const html = body.html ?? null
  const htmlBytes = html ? bytes(html) : 0
  const keptHtml = html && htmlBytes <= HTML_LIMIT_BYTES ? html : null

  await tx
    .insert(messageBody)
    .values({
      accountId: ctx.accountId,
      messageId,
      textBody: text,
      htmlBody: keptHtml,
      textBytes: bytes(text),
      htmlBytes: keptHtml ? htmlBytes : 0,
      truncated,
    })
    .onConflictDoUpdate({
      target: messageBody.messageId,
      set: {
        textBody: text,
        htmlBody: keptHtml,
        textBytes: bytes(text),
        htmlBytes: keptHtml ? htmlBytes : 0,
        truncated,
        storedAt: new Date(),
      },
    })

  await tx
    .update(message)
    .set({ bodyState: truncated ? 'too_large' : 'stored', bodyError: null })
    .where(eq(message.id, messageId))
}

export type IngestResult =
  | { stored: true; messageId: string; threadId: string; contactIds: string[]; created: boolean; activityId: string | null }
  | { stored: false; reason: string }

/** Which sequence a stored copy of a sent step belongs to, so its timeline card
 *  says so and the send row can be joined to it. Absent for ordinary mail. */
export type MessageOrigin = { sequenceId: string; sequenceName: string }

const lower = (value: string): string => value.trim().toLowerCase()

const addressesOf = (incoming: IncomingMessage): string[] =>
  [...new Set([incoming.from, ...incoming.to, ...incoming.cc].map(lower).filter(Boolean))]

/** Blocklisting is applied at ingest, so a blocked thread is never stored, not
 *  stored-and-hidden. B3.
 *
 *  Two rules, both of which mean "this is not CRM correspondence":
 *    - every participant is internal, so it is a colleague-to-colleague thread,
 *    - an address or domain is on the account list or the owner's own list.
 *
 *  A free mail provider is deliberately not one of them. Refusing gmail.com threw
 *  away every founder and sole trader who writes from a personal address, which is
 *  a large share of real inbound. What it protected against instead lives where it
 *  belongs: the exclusion list, and the mailbox's own private setting. Creating a
 *  contact is still refused for those domains, so a stranger never becomes a
 *  record. */
/** Which mail domain counts as "us": the one the account is claimed by. Never per
 *  deployment, because the same process serves several tenants and reading one
 *  tenant's domain onto another's mailbox inverts every internal/external
 *  decision below. */
export const internalDomainOf = async (ctx: AccountContext): Promise<string> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{ domain: string }>(
      sql`select google_hosted_domain as domain from account limit 1`,
    )
    if (!row) throw new Error('That account no longer exists.')
    return row.domain
  })

export const shouldSkip = (
  incoming: IncomingMessage,
  options: { internalDomain: string; blocked: Set<string>; ownerEmail?: string | undefined },
): string | null => {
  const addresses = addressesOf(incoming)
  if (addresses.length === 0) return 'The message named nobody.'

  // The person who connected the mailbox is us, whatever their address is at. A
  // company on plain Gmail rather than Account has no domain of its own, and
  // reading only the organisation's domain made every one of their threads look
  // like a stranger's.
  const owner = options.ownerEmail ? lower(options.ownerEmail) : null
  const internal = (address: string) =>
    address === owner || registrableDomain(address.split('@')[1] ?? '') === options.internalDomain

  if (addresses.every(internal)) {
    return 'Every participant is internal, so this is a colleague-to-colleague thread.'
  }

  for (const address of addresses) {
    const domain = address.split('@')[1] ?? ''
    if (options.blocked.has(address) || options.blocked.has(domain)) {
      return `${address} is on the exclusion list.`
    }
  }
  return null
}

export const blockedPatterns = async (ctx: AccountContext, userId: string): Promise<Set<string>> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx
      .select({ pattern: messageBlocklist.pattern })
      .from(messageBlocklist)
      .where(or(isNull(messageBlocklist.userId), eq(messageBlocklist.userId, userId)))
    return new Set(rows.map((row) => row.pattern))
  })

/** Stores one message, its thread and its participants, and links the thread to
 *  every record the participants imply.
 *
 *  Idempotent on provider_message_id, which is what makes killing a back-fill and
 *  restarting it produce no duplicates. B2. */
/** A delivery report is not correspondence: it is a machine telling us an address
 *  is dead. It must never become a contact or a thread, and it must never be
 *  filtered out either, which is what nearly happened here: bounces arrive from
 *  mailer-daemon at the provider's own domain, and the rule that keeps personal
 *  mail out of the CRM was throwing them away before anything could read them. */

export const ingestMessage = async (
  ctx: AccountContext,
  input: {
    incoming: IncomingMessage
    ownerEmail: string
    mailboxId: string
    internalDomain: string
    blocked: Set<string>
    origin?: MessageOrigin | undefined
  },
): Promise<IngestResult> => {
  assertCanWrite(ctx, 'mailbox')

  if (isDeliveryReport(input.incoming.from.trim().toLowerCase(), input.incoming.headers)) {
    await withAccount(ctx, (tx) =>
      detectReply(tx, ctx, {
        messageId: '',
        contactIds: [],
        fromAddr: input.incoming.from.trim().toLowerCase(),
        inReplyTo: input.incoming.inReplyTo ?? null,
        references: input.incoming.references ?? [],
        threadId: NO_THREAD,
        subject: input.incoming.subject,
        ...(input.incoming.headers ? { headers: input.incoming.headers } : {}),
      }),
    )
    return { stored: false, reason: 'A delivery report, read for the bounce and not stored.' }
  }

  const skip = shouldSkip(input.incoming, {
    internalDomain: input.internalDomain,
    blocked: input.blocked,
    ownerEmail: input.ownerEmail,
  })
  if (skip) return { stored: false, reason: skip }

  return withAccount(ctx, async (tx) => {
    if (!(await touchesARecord(tx, addressesOf(input.incoming), input.internalDomain, input.ownerEmail))) {
      return { stored: false, reason: 'Nobody on this thread is a contact or at a company here.' }
    }
    return storeMessage(tx, ctx, input)
  })
}

/** The rule the Gmail app page promises: a thread is filed on the contact, company
 *  or deal it is about, and mail that is about none of them is not the CRM's to
 *  hold. Without it a back-fill reads an entire personal mailbox -- eleven thousand
 *  threads, one of them linked to anybody -- and stores the bodies.
 *
 *  Two lookups, both indexed, and only for the handful of addresses on one message.
 *  The owner's own address is not a match: every message has it, so counting it
 *  would let everything through.
 *
 *  The cost is deliberate and worth naming: a first mail from a prospect who is not
 *  a contact yet, at a company that is not a record yet, is not stored. Making them
 *  a record is what files their mail, which is the same order HubSpot works in. */
const touchesARecord = async (
  tx: Tx,
  addresses: string[],
  internalDomain: string,
  ownerEmail: string,
): Promise<boolean> => {
  const owner = lower(ownerEmail)
  const theirs = addresses.filter((address) => address !== owner)
  if (theirs.length === 0) return false

  const [known] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(and(inArray(sql`lower(${contact.email})`, theirs), isNull(contact.deletedAt)))
    .limit(1)
  if (known) return true

  // employerDomainFromEmail refuses free and disposable providers, so a company
  // cannot be matched by gmail.com.
  const domains = [
    ...new Set(
      theirs
        .map((address) => employerDomainFromEmail(address))
        .filter((domain): domain is string => Boolean(domain) && domain !== internalDomain),
    ),
  ]
  if (domains.length === 0) return false

  const [matched] = await tx
    .select({ id: company.id })
    .from(company)
    .where(and(inArray(company.domain, domains), isNull(company.deletedAt)))
    .limit(1)
  return Boolean(matched)
}

/** A uuid that can never be a thread id, so the thread arm of the reply match is
 *  inert for a bounce: a delivery report belongs to no conversation of ours, and
 *  it must be matched on the Message-ID it is reporting on and nothing else. */
const NO_THREAD = '00000000-0000-0000-0000-000000000000'

const storeMessage = async (
  tx: Tx,
  ctx: AccountContext,
  input: { incoming: IncomingMessage; ownerEmail: string; mailboxId: string; internalDomain: string; origin?: MessageOrigin | undefined },
): Promise<IngestResult> => {
  const { incoming } = input

  const [thread] = await tx
    .insert(messageThread)
    .values({
      accountId: ctx.accountId,
      provider: 'gmail',
      providerThreadId: incoming.providerThreadId,
      subject: incoming.subject,
      firstAt: incoming.sentAt,
      lastAt: incoming.sentAt,
      messageCount: 0,
    })
    .onConflictDoUpdate({
      target: [messageThread.accountId, messageThread.provider, messageThread.providerThreadId],
      set: {
        subject: sql`coalesce(${messageThread.subject}, excluded.subject)`,
        firstAt: sql`least(${messageThread.firstAt}, excluded.first_at)`,
        lastAt: sql`greatest(${messageThread.lastAt}, excluded.last_at)`,
      },
    })
    .returning({ id: messageThread.id })
  if (!thread) throw new Error('The thread could not be stored.')

  const direction = lower(incoming.from) === lower(input.ownerEmail) ? 'outbound' : 'inbound'

  const [stored] = await tx
    .insert(message)
    .values({
      accountId: ctx.accountId,
      threadId: thread.id,
      providerMessageId: incoming.providerMessageId,
      direction,
      fromAddr: lower(incoming.from),
      toAddrs: incoming.to.map(lower),
      ccAddrs: incoming.cc.map(lower),
      sentAt: incoming.sentAt,
      snippet: incoming.snippet,
      internetMessageId: incoming.internetMessageId ?? null,
      inReplyTo: incoming.inReplyTo ?? null,
      references: incoming.references ?? [],
      bodyState: incoming.body ? 'stored' : 'pending',
      hasAttachments: incoming.hasAttachments,
      mailboxId: input.mailboxId,
    })
    .onConflictDoNothing({ target: [message.accountId, message.providerMessageId] })
    .returning({ id: message.id })

  if (!stored) {
    // Already read on an earlier run, or by a colleague's mailbox. Neither is a
    // failure, and re-counting it would inflate the thread.
    const [existing] = await tx
      .select({ id: message.id })
      .from(message)
      .where(eq(message.providerMessageId, incoming.providerMessageId))
      .limit(1)
    return { stored: true, messageId: existing?.id ?? '', threadId: thread.id, contactIds: [], created: false, activityId: null }
  }

  await tx
    .update(messageThread)
    .set({ messageCount: sql`${messageThread.messageCount} + 1` })
    .where(eq(messageThread.id, thread.id))

  if (incoming.body) await writeBody(tx, ctx, stored.id, incoming.body)

  if (incoming.attachments && incoming.attachments.length > 0) {
    await tx.insert(messageAttachment).values(
      incoming.attachments.map((attachment) => ({
        accountId: ctx.accountId,
        messageId: stored.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        providerAttachmentId: attachment.providerAttachmentId,
        inline: attachment.inline,
      })),
    )
  }

  const participants: { address: string; role: 'from' | 'to' | 'cc' }[] = [
    { address: lower(incoming.from), role: 'from' as const },
    ...incoming.to.map((address) => ({ address: lower(address), role: 'to' as const })),
    ...incoming.cc.map((address) => ({ address: lower(address), role: 'cc' as const })),
  ].filter((entry) => entry.address !== '')

  const matched = await matchParticipants(
    tx,
    ctx,
    participants.map((entry) => entry.address),
    input.internalDomain,
  )

  for (const entry of participants) {
    await tx
      .insert(messageParticipant)
      .values({
        accountId: ctx.accountId,
        messageId: stored.id,
        address: entry.address,
        contactId: matched.get(entry.address) ?? null,
        role: entry.role,
      })
      .onConflictDoNothing()
  }

  // A reply is what stops a sequence, and it arrives here rather than through a
  // provider webhook, which is the whole reason sequences send from a mailbox we
  // already read.
  if (direction === 'inbound') {
    await detectReply(tx, ctx, {
      messageId: stored.id,
      contactIds: [...new Set([...matched.values()])],
      fromAddr: lower(incoming.from),
      inReplyTo: incoming.inReplyTo ?? null,
      references: incoming.references ?? [],
      threadId: thread.id,
      subject: incoming.subject,
      ...(incoming.headers ? { headers: incoming.headers } : {}),
    })
  }

  const contactIds = [...new Set([...matched.values()])]
  let activityId: string | null = null
  if (contactIds.length > 0) {
    await refreshEmailEngagement(tx, ctx, contactIds)
    activityId = await linkThreadActivity(tx, ctx, {
      threadId: thread.id,
      messageId: stored.id,
      subject: incoming.subject,
      snippet: incoming.snippet,
      sentAt: incoming.sentAt,
      direction,
      counterpart: direction === 'inbound' ? [lower(incoming.from)] : incoming.to.map(lower),
      contactIds,
      origin: input.origin,
    })
  }

  return { stored: true, messageId: stored.id, threadId: thread.id, contactIds, created: true, activityId }
}

/** An address matches a contact on lower(email). No match and the domain is known:
 *  create the contact under that company, owner unassigned. No match and the domain
 *  is unknown, free or internal: create nothing and leave the address unlinked. B3.
 *
 *  Creating a contact for every stranger who ever emailed anybody would fill the
 *  CRM with noise; creating one for a new person at a company already being sold
 *  to is exactly what a salesperson wants. */
const matchParticipants = async (
  tx: Tx,
  ctx: AccountContext,
  addresses: string[],
  internalDomain: string,
): Promise<Map<string, string>> => {
  const unique = [...new Set(addresses)].filter(Boolean)
  if (unique.length === 0) return new Map()

  const found = await tx
    .select({ id: contact.id, email: contact.email })
    .from(contact)
    .where(and(inArray(sql`lower(${contact.email})`, unique), isNull(contact.deletedAt)))

  const matched = new Map<string, string>()
  for (const row of found) {
    if (row.email) matched.set(lower(row.email), row.id)
  }

  for (const address of unique) {
    if (matched.has(address)) continue
    const domain = employerDomainFromEmail(address)
    // employerDomainFromEmail already refuses free and disposable providers.
    if (!domain || domain === internalDomain) continue

    const [company] = await tx.execute<{ id: string }>(
      sql`select id from company where domain = ${domain} and deleted_at is null limit 1`,
    )
    if (!company) continue

    const [created] = await tx.execute<{ id: string }>(sql`
      insert into contact (account_id, email, company_id, lead_source)
      values (${ctx.accountId}, ${address}, ${company.id}, 'Offline Sources')
      on conflict do nothing
      returning id`)
    if (created) {
      matched.set(address, created.id)
      await requestEnrichment(tx, ctx, 'contact', created.id)
      await writeAudit(tx, ctx, {
        entity: 'contact',
        entityId: created.id,
        action: 'create',
        before: null,
        after: { email: address, via: 'gmail_participant_match' },
      })
    }
  }

  return matched
}

/** A matched contact links the thread to the contact, to the contact's company,
 *  and to any deal the contact is associated with. B3. */
const linkThreadActivity = async (
  tx: Tx,
  ctx: AccountContext,
  input: {
    threadId: string
    messageId: string
    subject: string | null
    snippet: string | null
    sentAt: Date
    direction: 'inbound' | 'outbound'
    counterpart: string[]
    contactIds: string[]
    origin?: MessageOrigin | undefined
  },
): Promise<string | null> => {
  const payload: EmailPayload = {
    threadId: input.threadId,
    messageId: input.messageId,
    direction: input.direction,
    counterpart: input.counterpart,
    source: input.origin ? 'sequence' : 'gmail',
    ...(input.origin ? { sequenceId: input.origin.sequenceId, sequenceName: input.origin.sequenceName } : {}),
  }
  return recordActivity(tx, ctx, {
    type: 'email',
    subject: input.subject ?? '(no subject)',
    body: input.snippet,
    occurredAt: input.sentAt,
    payload,
    links: await linksForContacts(tx, input.contactIds),
  })
}

// -------------------------------------------------------------- reading

export type ThreadSummary = {
  id: string
  subject: string | null
  firstAt: Date | null
  lastAt: Date | null
  messageCount: number
}

/** The threads one contact appears in, newest first. */
export const threadsForContact = async (
  ctx: AccountContext,
  contactId: string,
  limit = 20,
): Promise<ThreadSummary[]> =>
  withAccount(ctx, (tx) =>
    tx
      .selectDistinct({
        id: messageThread.id,
        subject: messageThread.subject,
        firstAt: messageThread.firstAt,
        lastAt: messageThread.lastAt,
        messageCount: messageThread.messageCount,
      })
      .from(messageThread)
      .innerJoin(message, eq(message.threadId, messageThread.id))
      .innerJoin(messageParticipant, eq(messageParticipant.messageId, message.id))
      .where(eq(messageParticipant.contactId, contactId))
      .orderBy(desc(messageThread.lastAt))
      .limit(Math.min(Math.max(limit, 1), 100)),
  )

export type ThreadMessage = {
  id: string
  direction: 'inbound' | 'outbound'
  fromAddr: string | null
  toAddrs: string[]
  ccAddrs: string[]
  sentAt: Date
  snippet: string | null
  hasAttachments: boolean
  bodyState: BodyState
  bodyError: string | null
  text: string | null
  html: string | null
  truncated: boolean
  attachments: { id: string; filename: string; mimeType: string | null; sizeBytes: number }[]
}

export type BodyState = 'pending' | 'stored' | 'too_large' | 'failed'

/** Who may read a message. Three ways in, and the caller's own identity decides,
 *  never the client:
 *    - the mailbox that read it is gone, so this is account history now,
 *    - the mailbox is shared with the team, which is the default,
 *    - the caller owns that mailbox, or administers the account.
 *
 *  Written as one predicate rather than three call sites, because a reader that
 *  forgets it is a private mailbox leaked. */
const readable = (ctx: AccountContext) => sql`(
  ${message.mailboxId} is null
  or exists (
    select 1 from mailbox mb
     where mb.id = ${message.mailboxId}
       and (mb.visibility = 'team'
            or mb.user_id = ${ctx.actorId}::uuid
            or ${isAdmin(ctx)})
  )
)`

export const readThread = async (
  ctx: AccountContext,
  threadId: string,
): Promise<{
  thread: ThreadSummary
  /** Everyone on the thread who is a contact, so the header can link them. */
  contacts: { id: string; name: string; email: string | null }[]
  messages: ThreadMessage[]
} | null> =>
  withAccount(ctx, async (tx) => {
    const [thread] = await tx
      .select({
        id: messageThread.id,
        subject: messageThread.subject,
        firstAt: messageThread.firstAt,
        lastAt: messageThread.lastAt,
        messageCount: messageThread.messageCount,
      })
      .from(messageThread)
      .where(eq(messageThread.id, threadId))
      .limit(1)
    if (!thread) return null

    const rows = await tx
      .select({
        id: message.id,
        direction: message.direction,
        fromAddr: message.fromAddr,
        toAddrs: message.toAddrs,
        ccAddrs: message.ccAddrs,
        sentAt: message.sentAt,
        snippet: message.snippet,
        hasAttachments: message.hasAttachments,
        bodyState: message.bodyState,
        bodyError: message.bodyError,
        text: messageBody.textBody,
        html: messageBody.htmlBody,
        truncated: messageBody.truncated,
      })
      .from(message)
      .leftJoin(messageBody, eq(messageBody.messageId, message.id))
      .where(and(eq(message.threadId, threadId), readable(ctx)))
      .orderBy(asc(message.sentAt))

    if (rows.length === 0) return null

    const attachments = await tx
      .select({
        id: messageAttachment.id,
        messageId: messageAttachment.messageId,
        filename: messageAttachment.filename,
        mimeType: messageAttachment.mimeType,
        sizeBytes: messageAttachment.sizeBytes,
      })
      .from(messageAttachment)
      .where(
        and(
          inArray(
            messageAttachment.messageId,
            rows.map((row) => row.id),
          ),
          eq(messageAttachment.inline, false),
        ),
      )

    // Which of the addresses on this thread are people in the CRM. The join
    // table is already written on ingest and already read by the list; the
    // thread itself was the one place showing raw addresses with nothing behind
    // them.
    const people = await tx.execute<{ id: string; name: string; email: string | null }>(sql`
      select distinct c.id,
             coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.email) as name,
             c.email
        from message_participant mp
        join contact c on c.id = mp.contact_id
       where mp.message_id in (${sql.join(
         rows.map((row) => sql`${row.id}::uuid`),
         sql`, `,
       )})
         and c.deleted_at is null`)

    return {
      thread,
      contacts: people.map((person) => ({
        id: person.id,
        name: person.name,
        email: person.email,
      })),
      messages: rows.map((row) => ({
        ...row,
        truncated: row.truncated ?? false,
        attachments: attachments
          .filter((file) => file.messageId === row.id)
          .map(({ messageId: _messageId, ...file }) => file),
      })),
    }
  })

/** Marks a thread read up to now, for one person. Separate from `readThread` so a
 *  background refresh does not silently mark somebody's inbox read. */
export const markThreadRead = async (ctx: AccountContext, threadId: string): Promise<void> => {
  if (!ctx.actorId) return
  await mutate(ctx, 'message_thread_read', async (tx) => {
    await tx
      .insert(messageThreadRead)
      .values({ accountId: ctx.accountId, threadId, userId: ctx.actorId as string, lastReadAt: new Date() })
      .onConflictDoUpdate({
        target: [messageThreadRead.accountId, messageThreadRead.threadId, messageThreadRead.userId],
        set: { lastReadAt: new Date() },
      })
    return { result: undefined, audit: { entity: 'message_thread_read', entityId: threadId, action: 'read' } }
  })
}

export type InboxThread = {
  id: string
  subject: string | null
  lastAt: Date | null
  messageCount: number
  /** The newest message's direction, which is what "waiting on a reply" means. */
  lastDirection: 'inbound' | 'outbound' | null
  lastFrom: string | null
  snippet: string | null
  unread: boolean
  /** Contacts on the thread, for the rail beside it. */
  contacts: { id: string; name: string }[]
  mailboxEmails: string[]
}

export type InboxPage = { threads: InboxThread[]; cursor: { lastAt: string; id: string } | null }

/** The shared inbox. Keyset paged on (last_at desc, id desc) over
 *  `message_thread_last_idx`, so page fifty costs what page one costs.
 *
 *  O(page) per call: the filters are all on the thread or on one correlated
 *  exists, never a scan of every message in the account. */
export const listInboxThreads = async (
  ctx: AccountContext,
  input: {
    scope?: 'mine' | 'all' | undefined
    mailboxId?: string | null | undefined
    unreplied?: boolean | undefined
    unread?: boolean | undefined
    q?: string | null | undefined
    limit?: number | undefined
    cursor?: { lastAt: string; id: string } | null | undefined
  } = {},
): Promise<InboxPage> =>
  withAccount(ctx, async (tx) => {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
    const scope = input.scope ?? 'all'
    const actor = ctx.actorId

    const rows = await tx.execute<{
      id: string
      subject: string | null
      last_at: Date | null
      message_count: number
      last_direction: 'inbound' | 'outbound' | null
      last_from: string | null
      snippet: string | null
      unread: boolean
      contacts: { id: string; name: string }[] | null
      mailbox_emails: string[] | null
    }>(sql`
      with visible as (
        select m.*, mb.user_id as mailbox_user, mb.email as mailbox_email
          from message m
          left join mailbox mb on mb.id = m.mailbox_id
         where m.mailbox_id is null
            or mb.visibility = 'team'
            or mb.user_id = ${actor}::uuid
            or ${isAdmin(ctx)}
      ),
      newest as (
        select distinct on (v.thread_id)
               v.thread_id, v.direction, v.from_addr, v.snippet, v.sent_at
          from visible v
         order by v.thread_id, v.sent_at desc
      )
      select t.id, t.subject, t.last_at, t.message_count,
             n.direction as last_direction, n.from_addr as last_from, n.snippet,
             (r.last_read_at is null or r.last_read_at < t.last_at) as unread,
             (select json_agg(distinct jsonb_build_object('id', c.id, 'name',
                        coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.email)))
                from visible vm
                join message_participant mp on mp.message_id = vm.id
                join contact c on c.id = mp.contact_id
               where vm.thread_id = t.id) as contacts,
             (select array_agg(distinct vm.mailbox_email)
                from visible vm where vm.thread_id = t.id and vm.mailbox_email is not null) as mailbox_emails
        from message_thread t
        join newest n on n.thread_id = t.id
        left join message_thread_read r on r.thread_id = t.id and r.user_id = ${actor}::uuid
       where exists (select 1 from visible v where v.thread_id = t.id)
         and (${scope === 'all'} or exists (
              select 1 from visible v where v.thread_id = t.id and v.mailbox_user = ${actor}::uuid))
         and (${input.mailboxId ?? null}::uuid is null or exists (
              select 1 from visible v where v.thread_id = t.id and v.mailbox_id = ${input.mailboxId ?? null}::uuid))
         and (${input.unreplied !== true} or n.direction = 'inbound')
         and (${input.unread !== true} or r.last_read_at is null or r.last_read_at < t.last_at)
         and (${input.q ?? null}::text is null
              or t.subject ilike ${input.q ? `%${input.q}%` : null}
              or exists (select 1 from visible v
                          where v.thread_id = t.id
                            and (v.from_addr ilike ${input.q ? `%${input.q}%` : null}
                                 or v.snippet ilike ${input.q ? `%${input.q}%` : null})))
         and (${input.cursor?.lastAt ?? null}::timestamptz is null
              or (t.last_at, t.id) < (${input.cursor?.lastAt ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid))
       order by t.last_at desc, t.id desc
       limit ${limit + 1}
    `)

    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return {
      threads: page.map((row) => ({
        id: row.id,
        subject: row.subject,
        lastAt: row.last_at ? new Date(row.last_at) : null,
        messageCount: Number(row.message_count),
        lastDirection: row.last_direction,
        lastFrom: row.last_from,
        snippet: row.snippet,
        unread: row.unread,
        contacts: row.contacts ?? [],
        mailboxEmails: row.mailbox_emails ?? [],
      })),
      cursor:
        rows.length > limit && last?.last_at
          ? { lastAt: new Date(last.last_at).toISOString(), id: last.id }
          : null,
    }
  })

export type InboxCounts = { all: number; mine: number; unreplied: number; unread: number }

/** The numbers beside the inbox views: every thread this person may read, the
 *  ones in their own mailboxes, the ones whose newest message is inbound, and
 *  the ones they have not opened since the last message. One pass over the
 *  visible threads, O(threads) in one round trip rather than four. */
export const inboxCounts = async (ctx: AccountContext): Promise<InboxCounts> =>
  withAccount(ctx, async (tx) => {
    const actor = ctx.actorId
    const [row] = await tx.execute<{ all: number; mine: number; unreplied: number; unread: number }>(sql`
      with visible as (
        select m.thread_id, m.direction, m.sent_at, mb.user_id as mailbox_user
          from message m
          left join mailbox mb on mb.id = m.mailbox_id
         where m.mailbox_id is null
            or mb.visibility = 'team'
            or mb.user_id = ${actor}::uuid
            or ${isAdmin(ctx)}
      ),
      newest as (
        select distinct on (v.thread_id) v.thread_id, v.direction
          from visible v
         order by v.thread_id, v.sent_at desc
      )
      select count(*)::int as all,
             count(*) filter (where exists (
               select 1 from visible v where v.thread_id = t.id and v.mailbox_user = ${actor}::uuid))::int as mine,
             count(*) filter (where n.direction = 'inbound')::int as unreplied,
             count(*) filter (where r.last_read_at is null or r.last_read_at < t.last_at)::int as unread
        from message_thread t
        join newest n on n.thread_id = t.id
        left join message_thread_read r on r.thread_id = t.id and r.user_id = ${actor}::uuid
    `)
    return { all: row?.all ?? 0, mine: row?.mine ?? 0, unreplied: row?.unreplied ?? 0, unread: row?.unread ?? 0 }
  })

/** How many bodies are still to fetch, and for which mailbox. Shown on the
 *  mailboxes screen so a long back-fill is visible rather than mysterious. */
export const bodyProgress = async (
  ctx: AccountContext,
): Promise<{ mailboxId: string; pending: number; stored: number }[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{ mailbox_id: string; pending: number; stored: number }>(sql`
      select mailbox_id,
             count(*) filter (where body_state = 'pending')::int as pending,
             count(*) filter (where body_state <> 'pending')::int as stored
        from message
       where mailbox_id is not null
       group by mailbox_id
    `)
    return rows.map((row) => ({
      mailboxId: row.mailbox_id,
      pending: Number(row.pending),
      stored: Number(row.stored),
    }))
  })

/** The next messages whose bodies have not been fetched, for one mailbox. The
 *  partial index makes this the size of the backlog, not of the mailbox. */
export const pendingBodies = async (
  ctx: AccountContext,
  mailboxId: string,
  limit = 50,
): Promise<{ id: string; providerMessageId: string }[]> =>
  withAccount(ctx, (tx) =>
    tx
      .select({ id: message.id, providerMessageId: message.providerMessageId })
      .from(message)
      .where(and(eq(message.mailboxId, mailboxId), eq(message.bodyState, 'pending')))
      .orderBy(desc(message.sentAt))
      .limit(Math.min(Math.max(limit, 1), 200)),
  )

export const storeBody = async (
  ctx: AccountContext,
  messageId: string,
  body: MessageBodyInput,
): Promise<void> => {
  await mutate(ctx, 'mailbox', async (tx) => {
    await writeBody(tx, ctx, messageId, body)
    return { result: undefined, audit: { entity: 'message', entityId: messageId, action: 'store_body' } }
  })
}

/** A body that cannot be fetched is marked and left alone, so the queue drains
 *  rather than spinning on the same message for ever. */
export const failBody = async (ctx: AccountContext, messageId: string, reason: string): Promise<void> =>
  withAccount(ctx, async (tx) => {
    await tx
      .update(message)
      .set({ bodyState: 'failed', bodyError: reason.slice(0, 500) })
      .where(eq(message.id, messageId))
  })

export const setMailboxVisibility = async (
  ctx: AccountContext,
  input: { mailboxId: string; visibility: 'team' | 'private' },
): Promise<void> =>
  mutate(ctx, 'mailbox', async (tx) => {
    const [box] = await tx
      .select({ userId: mailbox.userId, visibility: mailbox.visibility })
      .from(mailbox)
      .where(eq(mailbox.id, input.mailboxId))
    if (!box) throw new Error('That mailbox is not in this account.')
    // Finer than the role matrix can say: it is your mailbox, or you administer
    // the account.
    if (box.userId !== ctx.actorId && !isAdmin(ctx)) {
      throw new Error('That is somebody else\'s mailbox. Only they or an admin can change who reads it.')
    }
    await tx.update(mailbox).set({ visibility: input.visibility }).where(eq(mailbox.id, input.mailboxId))
    return {
      result: undefined,
      audit: {
        entity: 'mailbox',
        entityId: input.mailboxId,
        action: 'set_visibility',
        before: { visibility: box.visibility },
        after: { visibility: input.visibility },
      },
    }
  })

/** Puts a contact on the mail they were already on.
 *
 *  Ingest refuses to invent a contact for every stranger who ever wrote in, which
 *  is right, and leaves the one address somebody actually wanted sitting in a
 *  thread as plain text. Once they make that address a contact, this is what
 *  hangs the existing conversation on the new record, rather than leaving the
 *  history to start from today.
 *
 *  O(messages carrying that address), which is the size of one person's
 *  correspondence, not of the mailbox. */
export const attachContactToMail = async (
  ctx: AccountContext,
  contactId: string,
): Promise<{ messages: number; threads: number }> => {
  assertCanWrite(ctx, 'contact')
  return withAccount(ctx, async (tx) => {
    const [person] = await tx
      .select({ email: contact.email })
      .from(contact)
      .where(eq(contact.id, contactId))
      .limit(1)
    if (!person?.email) return { messages: 0, threads: 0 }
    const address = lower(person.email)

    const linked = await tx.execute<{ message_id: string }>(sql`
      update message_participant p
         set contact_id = ${contactId}::uuid
       where p.contact_id is null
         and p.address = ${address}
      returning p.message_id`)
    if (linked.length === 0) return { messages: 0, threads: 0 }

    const ids = [...new Set(linked.map((row) => row.message_id))]
    const messages = await tx.execute<{
      id: string
      thread_id: string
      subject: string | null
      snippet: string | null
      sent_at: Date
      direction: 'inbound' | 'outbound'
      from_addr: string | null
      to_addrs: string[]
    }>(sql`
      select m.id, m.thread_id, t.subject, m.snippet, m.sent_at, m.direction, m.from_addr, m.to_addrs
        from message m join message_thread t on t.id = m.thread_id
       where m.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
       order by m.sent_at`)

    for (const row of messages) {
      await linkThreadActivity(tx, ctx, {
        threadId: row.thread_id,
        messageId: row.id,
        subject: row.subject,
        snippet: row.snippet,
        sentAt: row.sent_at instanceof Date ? row.sent_at : new Date(row.sent_at),
        direction: row.direction,
        counterpart: row.direction === 'inbound' ? [row.from_addr ?? address] : row.to_addrs,
        contactIds: [contactId],
      })
    }

    await refreshEmailEngagement(tx, ctx, [contactId])
    return { messages: messages.length, threads: new Set(messages.map((row) => row.thread_id)).size }
  })
}
