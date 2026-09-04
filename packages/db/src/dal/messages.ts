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
import { contact } from '../schema/records.ts'
import { userAccount } from '../schema/identity.ts'
import { recordActivity } from './activity.ts'
import { detectReply } from './sequences.ts'
import type { WorkspaceContext } from './context.ts'
import { assertCanWrite } from './context.ts'
import { employerDomainFromEmail, isFreeMailDomain, registrableDomain } from './domains.ts'
import { decryptToken, encryptToken } from '../internal/crypto.ts'
import { refreshEmailEngagement } from './engagement.ts'
import { mutate, withWorkspace, writeAudit, type Tx } from './index.ts'

/** F1 phase B, the storage half. The Gmail calls live in the app; everything that
 *  decides what is kept, who it belongs to and what is refused lives here. */

export type MailboxState = 'connected' | 'backfilling' | 'revoked' | 'error' | 'paused'

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
  visibility: 'team' | 'private'
  /** True once it has been reconnected with the send scope. Until then it reads
   *  and cannot send, whatever a sequence asks of it. */
  canSend: boolean
  dailyCap: number
  minGapSeconds: number
}

export const listMailboxes = async (ctx: WorkspaceContext): Promise<MailboxRow[]> =>
  withWorkspace(ctx, async (tx) => {
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
    // One number for the workspace: threads are shared across mailboxes by design,
    // so "how many threads has this mailbox contributed" is not a thing worth
    // counting twice.
    return rows.map((row) => ({ ...row, threadCount: Number(counts?.n ?? 0) }))
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
export const saveMailbox = async (ctx: WorkspaceContext, input: SaveMailboxInput): Promise<{ id: string }> =>
  mutate(ctx, 'mailbox', async (tx) => {
    const [saved] = await tx
      .insert(mailbox)
      .values({
        workspaceId: ctx.workspaceId,
        userId: input.userId,
        email: input.email.toLowerCase(),
        state: 'backfilling',
        accessToken: encryptToken(input.accessToken),
        refreshToken: encryptToken(input.refreshToken),
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        canSend: input.canSend ?? false,
        lastError: null,
        lastErrorAt: null,
      })
      .onConflictDoUpdate({
        target: [mailbox.workspaceId, mailbox.userId],
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
}

/** Decrypted only here, only for a sync run. */
export const readMailbox = async (
  ctx: WorkspaceContext,
  mailboxId: string,
): Promise<MailboxTokens | null> =>
  withWorkspace(ctx, async (tx) => {
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
    }
  })

export const updateMailboxCursor = async (
  ctx: WorkspaceContext,
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
  await withWorkspace(ctx, async (tx) => {
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
  ctx: WorkspaceContext,
  mailboxId: string,
  error: string,
  revoked: boolean,
): Promise<void> => {
  await withWorkspace(ctx, async (tx) => {
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

export const disconnectMailbox = async (ctx: WorkspaceContext, mailboxId: string): Promise<void> =>
  mutate(ctx, 'mailbox', async (tx) => {
    const [found] = await tx
      .select({ email: mailbox.email, userId: mailbox.userId })
      .from(mailbox)
      .where(eq(mailbox.id, mailboxId))
      .limit(1)
    if (!found) throw new Error('That mailbox is not connected.')
    if (ctx.role !== 'admin' && found.userId !== ctx.actorId) {
      throw new Error('That is somebody else’s mailbox. Only they, or an admin, can disconnect it.')
    }

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
        after: { messagesKept: true },
      },
    }
  })

// ------------------------------------------------------------- blocklist

export type BlocklistRow = { id: string; pattern: string; note: string | null; userId: string | null }

export const listBlocklist = async (ctx: WorkspaceContext): Promise<BlocklistRow[]> =>
  withWorkspace(ctx, (tx) =>
    tx
      .select({
        id: messageBlocklist.id,
        pattern: messageBlocklist.pattern,
        note: messageBlocklist.note,
        userId: messageBlocklist.userId,
      })
      .from(messageBlocklist)
      .where(
        ctx.role === 'admin'
          ? undefined
          : or(isNull(messageBlocklist.userId), eq(messageBlocklist.userId, ctx.actorId ?? '')),
      )
      .orderBy(asc(messageBlocklist.pattern)),
  )

export const addBlocklistEntry = async (
  ctx: WorkspaceContext,
  input: { pattern: string; note?: string | null; scope: 'workspace' | 'mine' },
): Promise<{ id: string }> =>
  mutate(ctx, 'message_blocklist', async (tx) => {
    const pattern = input.pattern.trim().toLowerCase()
    if (!pattern || pattern.includes(' ')) {
      throw new Error('A blocklist entry is one address or one domain, with no spaces.')
    }
    if (input.scope === 'workspace' && ctx.role !== 'admin') {
      throw new Error('Only an admin sets a workspace-wide exclusion. Add it to your own list instead.')
    }

    const [created] = await tx
      .insert(messageBlocklist)
      .values({
        workspaceId: ctx.workspaceId,
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

export const removeBlocklistEntry = async (ctx: WorkspaceContext, id: string): Promise<void> =>
  mutate(ctx, 'message_blocklist', async (tx) => {
    const [found] = await tx
      .select({ pattern: messageBlocklist.pattern, userId: messageBlocklist.userId })
      .from(messageBlocklist)
      .where(eq(messageBlocklist.id, id))
      .limit(1)
    if (!found) throw new Error('That exclusion no longer exists.')
    if (found.userId === null && ctx.role !== 'admin') {
      throw new Error('That is a workspace exclusion. Only an admin removes one.')
    }
    if (found.userId !== null && found.userId !== ctx.actorId && ctx.role !== 'admin') {
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
  ctx: WorkspaceContext,
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
      workspaceId: ctx.workspaceId,
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
  | { stored: true; messageId: string; threadId: string; contactIds: string[]; created: boolean }
  | { stored: false; reason: string }

const lower = (value: string): string => value.trim().toLowerCase()

const addressesOf = (incoming: IncomingMessage): string[] =>
  [...new Set([incoming.from, ...incoming.to, ...incoming.cc].map(lower).filter(Boolean))]

/** Blocklisting is applied at ingest, so a blocked thread is never stored, not
 *  stored-and-hidden. B3.
 *
 *  Three rules, all of which mean "this is not CRM correspondence":
 *    - every participant is internal, so it is a colleague-to-colleague thread,
 *    - a participant is at a free or disposable mail provider, which is personal,
 *    - an address or domain is on the workspace list or the owner's own list. */
/** Which mail domain counts as "us". Read through the workspace's organisation,
 *  which is where the domain lives: a domain identifies the company, and every
 *  workspace it owns shares it. Never per deployment, because the same process
 *  serves several tenants and reading one tenant's domain onto another's mailbox
 *  inverts every internal/external decision below. */
export const internalDomainOf = async (ctx: WorkspaceContext): Promise<string> =>
  withWorkspace(ctx, async (tx) => {
    const [row] = await tx.execute<{ domain: string }>(
      sql`select o.google_hosted_domain as domain
            from workspace w join organisation o on o.id = w.organisation_id
           limit 1`,
    )
    if (!row) throw new Error('That workspace no longer exists.')
    return row.domain
  })

export const shouldSkip = (
  incoming: IncomingMessage,
  options: { internalDomain: string; blocked: Set<string> },
): string | null => {
  const addresses = addressesOf(incoming)
  if (addresses.length === 0) return 'The message named nobody.'

  const internal = (address: string) => registrableDomain(address.split('@')[1] ?? '') === options.internalDomain
  if (addresses.every(internal)) {
    return 'Every participant is internal, so this is a colleague-to-colleague thread.'
  }

  for (const address of addresses) {
    const domain = address.split('@')[1] ?? ''
    if (options.blocked.has(address) || options.blocked.has(domain)) {
      return `${address} is on the exclusion list.`
    }
    if (!internal(address) && isFreeMailDomain(domain)) {
      return `${address} is a personal mail address.`
    }
  }
  return null
}

export const blockedPatterns = async (ctx: WorkspaceContext, userId: string): Promise<Set<string>> =>
  withWorkspace(ctx, async (tx) => {
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
const isDeliveryReport = (incoming: IncomingMessage): boolean =>
  /^(mailer-daemon|postmaster)@/i.test(incoming.from.trim().toLowerCase())

export const ingestMessage = async (
  ctx: WorkspaceContext,
  input: { incoming: IncomingMessage; ownerEmail: string; mailboxId: string; internalDomain: string; blocked: Set<string> },
): Promise<IngestResult> => {
  assertCanWrite(ctx, 'mailbox')

  if (isDeliveryReport(input.incoming)) {
    await withWorkspace(ctx, (tx) =>
      detectReply(tx, ctx, {
        messageId: '',
        contactIds: [],
        fromAddr: input.incoming.from.trim().toLowerCase(),
        inReplyTo: input.incoming.inReplyTo ?? null,
        references: input.incoming.references ?? [],
        threadId: NO_THREAD,
        subject: input.incoming.subject,
      }),
    )
    return { stored: false, reason: 'A delivery report, read for the bounce and not stored.' }
  }

  const skip = shouldSkip(input.incoming, {
    internalDomain: input.internalDomain,
    blocked: input.blocked,
  })
  if (skip) return { stored: false, reason: skip }

  return withWorkspace(ctx, async (tx) => storeMessage(tx, ctx, input))
}

/** A uuid that can never be a thread id, so the thread arm of the reply match is
 *  inert for a bounce: a delivery report belongs to no conversation of ours, and
 *  it must be matched on the Message-ID it is reporting on and nothing else. */
const NO_THREAD = '00000000-0000-0000-0000-000000000000'

const storeMessage = async (
  tx: Tx,
  ctx: WorkspaceContext,
  input: { incoming: IncomingMessage; ownerEmail: string; mailboxId: string; internalDomain: string },
): Promise<IngestResult> => {
  const { incoming } = input

  const [thread] = await tx
    .insert(messageThread)
    .values({
      workspaceId: ctx.workspaceId,
      provider: 'gmail',
      providerThreadId: incoming.providerThreadId,
      subject: incoming.subject,
      firstAt: incoming.sentAt,
      lastAt: incoming.sentAt,
      messageCount: 0,
    })
    .onConflictDoUpdate({
      target: [messageThread.workspaceId, messageThread.provider, messageThread.providerThreadId],
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
      workspaceId: ctx.workspaceId,
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
    .onConflictDoNothing({ target: [message.workspaceId, message.providerMessageId] })
    .returning({ id: message.id })

  if (!stored) {
    // Already read on an earlier run, or by a colleague's mailbox. Neither is a
    // failure, and re-counting it would inflate the thread.
    const [existing] = await tx
      .select({ id: message.id })
      .from(message)
      .where(eq(message.providerMessageId, incoming.providerMessageId))
      .limit(1)
    return { stored: true, messageId: existing?.id ?? '', threadId: thread.id, contactIds: [], created: false }
  }

  await tx
    .update(messageThread)
    .set({ messageCount: sql`${messageThread.messageCount} + 1` })
    .where(eq(messageThread.id, thread.id))

  if (incoming.body) await writeBody(tx, ctx, stored.id, incoming.body)

  if (incoming.attachments && incoming.attachments.length > 0) {
    await tx.insert(messageAttachment).values(
      incoming.attachments.map((attachment) => ({
        workspaceId: ctx.workspaceId,
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
        workspaceId: ctx.workspaceId,
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
  if (contactIds.length > 0) {
    await refreshEmailEngagement(tx, ctx, contactIds)
    await linkThreadActivity(tx, ctx, {
      threadId: thread.id,
      subject: incoming.subject,
      snippet: incoming.snippet,
      sentAt: incoming.sentAt,
      direction,
      contactIds,
    })
  }

  return { stored: true, messageId: stored.id, threadId: thread.id, contactIds, created: true }
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
  ctx: WorkspaceContext,
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
      insert into contact (workspace_id, email, company_id, lead_source)
      values (${ctx.workspaceId}, ${address}, ${company.id}, 'Offline Sources')
      on conflict do nothing
      returning id`)
    if (created) {
      matched.set(address, created.id)
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
  ctx: WorkspaceContext,
  input: {
    threadId: string
    subject: string | null
    snippet: string | null
    sentAt: Date
    direction: 'inbound' | 'outbound'
    contactIds: string[]
  },
): Promise<void> => {
  const links: { entityType: 'contact' | 'company' | 'deal'; entityId: string }[] = input.contactIds.map(
    (id) => ({ entityType: 'contact' as const, entityId: id }),
  )

  const companies = await tx.execute<{ company_id: string }>(sql`
    select distinct company_id from contact
     where id in (${sql.join(input.contactIds.map((id) => sql`${id}`), sql`, `)})
       and company_id is not null`)
  for (const row of companies) links.push({ entityType: 'company', entityId: row.company_id })

  const deals = await tx.execute<{ deal_id: string }>(sql`
    select distinct a.from_id as deal_id from association a
     where a.from_type = 'deal' and a.to_type = 'contact'
       and a.to_id in (${sql.join(input.contactIds.map((id) => sql`${id}`), sql`, `)})
    union
    select distinct a.to_id from association a
     where a.to_type = 'deal' and a.from_type = 'contact'
       and a.from_id in (${sql.join(input.contactIds.map((id) => sql`${id}`), sql`, `)})`)
  for (const row of deals) links.push({ entityType: 'deal', entityId: row.deal_id })

  await recordActivity(tx, ctx, {
    type: 'email',
    subject: input.subject ?? '(no subject)',
    body: input.snippet,
    occurredAt: input.sentAt,
    payload: { threadId: input.threadId, direction: input.direction, source: 'gmail' },
    links,
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
  ctx: WorkspaceContext,
  contactId: string,
  limit = 20,
): Promise<ThreadSummary[]> =>
  withWorkspace(ctx, (tx) =>
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
 *    - the mailbox that read it is gone, so this is workspace history now,
 *    - the mailbox is shared with the team, which is the default,
 *    - the caller owns that mailbox, or administers the workspace.
 *
 *  Written as one predicate rather than three call sites, because a reader that
 *  forgets it is a private mailbox leaked. */
const readable = (ctx: WorkspaceContext) => sql`(
  ${message.mailboxId} is null
  or exists (
    select 1 from mailbox mb
     where mb.id = ${message.mailboxId}
       and (mb.visibility = 'team'
            or mb.user_id = ${ctx.actorId}::uuid
            or ${ctx.role === 'admin'})
  )
)`

export const readThread = async (
  ctx: WorkspaceContext,
  threadId: string,
): Promise<{ thread: ThreadSummary; messages: ThreadMessage[] } | null> =>
  withWorkspace(ctx, async (tx) => {
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

    return {
      thread,
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
export const markThreadRead = async (ctx: WorkspaceContext, threadId: string): Promise<void> => {
  if (!ctx.actorId) return
  await mutate(ctx, 'message_thread_read', async (tx) => {
    await tx
      .insert(messageThreadRead)
      .values({ workspaceId: ctx.workspaceId, threadId, userId: ctx.actorId as string, lastReadAt: new Date() })
      .onConflictDoUpdate({
        target: [messageThreadRead.workspaceId, messageThreadRead.threadId, messageThreadRead.userId],
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
 *  exists, never a scan of every message in the workspace. */
export const listInboxThreads = async (
  ctx: WorkspaceContext,
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
  withWorkspace(ctx, async (tx) => {
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
            or ${ctx.role === 'admin'}
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

/** How many bodies are still to fetch, and for which mailbox. Shown on the
 *  mailboxes screen so a long back-fill is visible rather than mysterious. */
export const bodyProgress = async (
  ctx: WorkspaceContext,
): Promise<{ mailboxId: string; pending: number; stored: number }[]> =>
  withWorkspace(ctx, async (tx) => {
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
  ctx: WorkspaceContext,
  mailboxId: string,
  limit = 50,
): Promise<{ id: string; providerMessageId: string }[]> =>
  withWorkspace(ctx, (tx) =>
    tx
      .select({ id: message.id, providerMessageId: message.providerMessageId })
      .from(message)
      .where(and(eq(message.mailboxId, mailboxId), eq(message.bodyState, 'pending')))
      .orderBy(desc(message.sentAt))
      .limit(Math.min(Math.max(limit, 1), 200)),
  )

export const storeBody = async (
  ctx: WorkspaceContext,
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
export const failBody = async (ctx: WorkspaceContext, messageId: string, reason: string): Promise<void> =>
  withWorkspace(ctx, async (tx) => {
    await tx
      .update(message)
      .set({ bodyState: 'failed', bodyError: reason.slice(0, 500) })
      .where(eq(message.id, messageId))
  })

export const setMailboxVisibility = async (
  ctx: WorkspaceContext,
  input: { mailboxId: string; visibility: 'team' | 'private' },
): Promise<void> =>
  mutate(ctx, 'mailbox', async (tx) => {
    const [box] = await tx
      .select({ userId: mailbox.userId, visibility: mailbox.visibility })
      .from(mailbox)
      .where(eq(mailbox.id, input.mailboxId))
    if (!box) throw new Error('That mailbox is not in this workspace.')
    // Finer than the role matrix can say: it is your mailbox, or you administer
    // the workspace.
    if (box.userId !== ctx.actorId && ctx.role !== 'admin') {
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
