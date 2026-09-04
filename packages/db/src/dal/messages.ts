import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  mailbox,
  message,
  messageBlocklist,
  messageParticipant,
  messageThread,
} from '../schema/messaging.ts'
import { contact } from '../schema/records.ts'
import { userAccount } from '../schema/identity.ts'
import { recordActivity } from './activity.ts'
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
        after: { email: input.email, scope: 'gmail.readonly' },
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

export type IncomingMessage = {
  providerThreadId: string
  providerMessageId: string
  subject: string | null
  from: string
  to: string[]
  cc: string[]
  sentAt: Date
  snippet: string | null
  bodyRef: string | null
  hasAttachments: boolean
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
export const ingestMessage = async (
  ctx: WorkspaceContext,
  input: { incoming: IncomingMessage; ownerEmail: string; mailboxId: string; internalDomain: string; blocked: Set<string> },
): Promise<IngestResult> => {
  assertCanWrite(ctx, 'mailbox')
  const skip = shouldSkip(input.incoming, {
    internalDomain: input.internalDomain,
    blocked: input.blocked,
  })
  if (skip) return { stored: false, reason: skip }

  return withWorkspace(ctx, async (tx) => storeMessage(tx, ctx, input))
}

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
      bodyRef: incoming.bodyRef,
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
  /** False when no connected mailbox can fetch the body any more. */
  bodyAvailable: boolean
}

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

    const messages = await tx
      .select({
        id: message.id,
        direction: message.direction,
        fromAddr: message.fromAddr,
        toAddrs: message.toAddrs,
        ccAddrs: message.ccAddrs,
        sentAt: message.sentAt,
        snippet: message.snippet,
        hasAttachments: message.hasAttachments,
        bodyRef: message.bodyRef,
        mailboxState: mailbox.state,
      })
      .from(message)
      .leftJoin(mailbox, eq(mailbox.id, message.mailboxId))
      .where(eq(message.threadId, threadId))
      .orderBy(asc(message.sentAt))

    return {
      thread,
      messages: messages.map(({ bodyRef, mailboxState, ...row }) => ({
        ...row,
        bodyAvailable: bodyRef !== null && mailboxState !== null && mailboxState !== 'revoked',
      })),
    }
  })

export type MessageSource = {
  id: string
  threadId: string
  providerMessageId: string
  snippet: string | null
  mailbox: MailboxTokens
}

/** The message and the mailbox that can fetch its body. A row from before the
 *  mailbox was recorded falls back to a connected mailbox owned by one of the
 *  message's own participants, which is the only mailbox the id is valid in. */
export const messageSource = async (ctx: WorkspaceContext, messageId: string): Promise<MessageSource | null> =>
  withWorkspace(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: message.id,
        threadId: message.threadId,
        providerMessageId: message.providerMessageId,
        snippet: message.snippet,
        mailboxId: message.mailboxId,
        fromAddr: message.fromAddr,
        toAddrs: message.toAddrs,
        ccAddrs: message.ccAddrs,
      })
      .from(message)
      .where(eq(message.id, messageId))
      .limit(1)
    if (!row) return null

    const participants = [row.fromAddr ?? '', ...row.toAddrs, ...row.ccAddrs].filter(Boolean)
    const [box] = await tx
      .select()
      .from(mailbox)
      .where(
        row.mailboxId
          ? eq(mailbox.id, row.mailboxId)
          : and(sql`lower(${mailbox.email}) in (${sql.join(participants.map((a) => sql`${a}`), sql`, `)})`, sql`${mailbox.state} <> 'revoked'`),
      )
      .limit(1)
    if (!box) return null

    return {
      id: row.id,
      threadId: row.threadId,
      providerMessageId: row.providerMessageId,
      snippet: row.snippet,
      mailbox: {
        id: box.id,
        userId: box.userId,
        email: box.email,
        state: box.state,
        accessToken: decryptToken(box.accessToken),
        refreshToken: decryptToken(box.refreshToken),
        accessTokenExpiresAt: box.accessTokenExpiresAt,
        historyId: box.historyId,
        backfillCursor: box.backfillCursor,
        backfillDone: box.backfillDone,
      },
    }
  })
