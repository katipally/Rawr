import {
  blockedPatterns,
  failBody,
  ingestMessage,
  internalDomainOf,
  pendingBodies,
  readMailbox,
  recordMailboxFailure,
  storeBody,
  updateMailboxCursor,
  type IncomingAttachment,
  type IncomingMessage,
  type WorkspaceContext,
} from '@rawr/db'
import { devGmailEnabled, googleConfigured } from '~/lib/env.ts'
import { googleClient } from './auth/google.ts'

/** Reading is what every mailbox is connected for. Nothing about the CRM needs
 *  more than this, and every extra scope widens the blast radius of a leaked
 *  token. */
export const GMAIL_READ_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

/** Sending is asked for separately and only by somebody who wants sequences sent
 *  as themselves. `gmail.send` can only send: it cannot read, modify or delete,
 *  which is why it is the one to ask for rather than `gmail.modify`.
 *
 *  A mailbox connected before this existed keeps reading and cannot send until
 *  its owner reconnects and grants it, which is the honest way round. */
export const GMAIL_SEND_SCOPES = [...GMAIL_READ_SCOPES, 'https://www.googleapis.com/auth/gmail.send']

export const GMAIL_SCOPES = GMAIL_READ_SCOPES

/** Whether what Google actually granted includes sending. Read from the token's
 *  own scope list rather than from what was asked for, because a person can
 *  untick one on the consent screen. */
export const grantedSending = (scopes: string[]): boolean =>
  scopes.includes('https://www.googleapis.com/auth/gmail.send')

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** How many message ids one back-fill pass claims. Small enough that killing the
 *  worker mid-run loses at most this much progress, large enough that four years
 *  of mail does not take all week. */
const PAGE_SIZE = 50

export class RevokedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RevokedError'
  }
}

/** Google's own signal that the grant is gone. Anything else is a transient error
 *  and is retried; this one stops the mailbox, because a withdrawn consent does
 *  not come back on its own and retrying would be the wrong answer to it. */
const isRevocation = (status: number, body: string): boolean =>
  status === 401 ||
  (status === 403 && /insufficient|forbidden|scope/i.test(body)) ||
  /invalid_grant/i.test(body)

type Fetcher = (
  path: string,
  params?: Record<string, string>,
  /** Set to POST a body. Reads pass neither and get a GET, which is every call
   *  this module made before sending existed. */
  send?: { method: 'POST'; body: string },
) => Promise<unknown>

/** Refreshes the access token when it is within a minute of expiry, and hands the
 *  new one back so the caller can store it. An access token lasts an hour, and a
 *  back-fill can easily run longer than that. */
const authorised = async (
  ctx: WorkspaceContext,
  mailboxId: string,
  tokens: { accessToken: string; refreshToken: string; accessTokenExpiresAt: Date | null },
): Promise<{ fetcher: Fetcher; accessToken: string }> => {
  let accessToken = tokens.accessToken
  const expiring = tokens.accessTokenExpiresAt && tokens.accessTokenExpiresAt.getTime() - Date.now() < 60_000

  if (expiring && googleConfigured) {
    try {
      const refreshed = await googleClient().refreshAccessToken(tokens.refreshToken)
      accessToken = refreshed.accessToken()
      await updateMailboxCursor(ctx, mailboxId, {
        accessToken,
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt(),
      })
    } catch (cause) {
      throw new RevokedError(
        `Google refused to refresh this mailbox's access: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }

  const fetcher: Fetcher = async (path, params, send) => {
    const url = new URL(`${API}${path}`)
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value)

    const response = await fetch(url, {
      method: send?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(send ? { 'content-type': 'application/json' } : {}),
      },
      ...(send ? { body: send.body } : {}),
      // Sending is slower than reading, and a timeout here means a mail that may
      // or may not have gone out, so it is given longer.
      signal: AbortSignal.timeout(send ? 45_000 : 20_000),
    })
    if (response.ok) return response.json()

    const body = await response.text()
    if (isRevocation(response.status, body)) {
      throw new RevokedError('Access to this mailbox has been withdrawn in the Google account.')
    }
    // A 404 on history.list means the stored historyId has aged out. The caller
    // turns that into a full re-list rather than a crash. B2.
    const error = new Error(`Gmail answered ${response.status}: ${body.slice(0, 300)}`)
    ;(error as Error & { status?: number }).status = response.status
    throw error
  }

  return { fetcher, accessToken }
}

// --------------------------------------------------------------- parsing

const headerValue = (headers: { name?: string; value?: string }[], name: string): string =>
  headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? ''

/** "Trevor Kwan <trevor@datasaur.ai>, someone@else.com" into bare addresses.
 *  Display names routinely contain commas inside quotes, so the split respects
 *  quoting rather than assuming a comma is always a separator. */
export const parseAddresses = (raw: string): string[] => {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const char of raw) {
    if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) {
      out.push(current)
      current = ''
      continue
    }
    current += char
  }
  out.push(current)

  return out
    .map((entry) => (entry.match(/<([^>]+)>/)?.[1] ?? entry).trim().toLowerCase())
    .filter((address) => address.includes('@'))
}

type GmailPayload = {
  headers?: { name?: string; value?: string }[]
  parts?: GmailPayload[]
  filename?: string
  mimeType?: string
  body?: { data?: string; attachmentId?: string; size?: number }
}

type GmailMessage = {
  id?: string
  threadId?: string
  internalDate?: string
  snippet?: string
  payload?: GmailPayload
}

const hasAttachment = (payload: GmailPayload | undefined): boolean => {
  if (!payload) return false
  if (payload.filename && payload.body?.attachmentId) return true
  return (payload.parts ?? []).some(hasAttachment)
}

const attachmentsOf = (payload: GmailPayload | undefined, into: IncomingAttachment[] = []): IncomingAttachment[] => {
  if (!payload) return into
  if (payload.filename && payload.body?.attachmentId) {
    into.push({
      filename: payload.filename,
      mimeType: payload.mimeType ?? null,
      sizeBytes: payload.body.size ?? 0,
      providerAttachmentId: payload.body.attachmentId,
      // An inline image referenced by the HTML rather than something a person
      // meant to attach. Kept, but not listed as an attachment.
      inline: (payload.headers ?? []).some((header) => /content-id/i.test(header.name ?? '')),
    })
  }
  for (const child of payload.parts ?? []) attachmentsOf(child, into)
  return into
}

/** A Message-ID is `<id@host>`. Stored as written, because that is what a reply's
 *  In-Reply-To will carry and what a match compares against. */
const messageIds = (raw: string): string[] => raw.match(/<[^>]+>/g) ?? []

export const toIncoming = (raw: GmailMessage): IncomingMessage | null => {
  const headers = raw.payload?.headers ?? []
  const from = parseAddresses(headerValue(headers, 'From'))[0]
  if (!raw.id || !raw.threadId || !from) return null

  const found = { text: [] as string[], html: [] as string[] }
  collect(raw.payload as BodyPart | undefined, found)
  const text = found.text.length > 0 ? found.text.join('\n').trim() : htmlToText(found.html.join('\n'))
  const html = found.html.length > 0 ? sanitiseHtml(found.html.join('\n')) : null
  // A metadata-only read has no parts to collect from, and leaves the message for
  // the hydrate job rather than storing an empty body over a real one.
  const body = text || html ? { text: text || raw.snippet || '', html } : null

  return {
    providerThreadId: raw.threadId,
    providerMessageId: raw.id,
    subject: headerValue(headers, 'Subject') || null,
    from,
    to: parseAddresses(headerValue(headers, 'To')),
    cc: parseAddresses(headerValue(headers, 'Cc')),
    sentAt: new Date(Number(raw.internalDate ?? Date.now())),
    snippet: raw.snippet ?? null,
    internetMessageId: messageIds(headerValue(headers, 'Message-ID'))[0] ?? null,
    inReplyTo: messageIds(headerValue(headers, 'In-Reply-To'))[0] ?? null,
    references: messageIds(headerValue(headers, 'References')),
    body,
    attachments: attachmentsOf(raw.payload).filter((file) => !file.inline),
    hasAttachments: hasAttachment(raw.payload),
  }
}

// ---------------------------------------------------------------- bodies

/** What a thread view renders. Text is what a person reads and what survives
 *  truncation; the HTML is sanitised here, before it is ever stored, so nothing a
 *  stranger sent is kept in a form that could execute if a future reader forgot
 *  the sandbox. */
const decodeBase64Url = (data: string): string => Buffer.from(data, 'base64url').toString('utf8')

type BodyPart = GmailPayload & { mimeType?: string; body?: { data?: string; attachmentId?: string; size?: number } }

const collect = (part: BodyPart | undefined, into: { text: string[]; html: string[] }): void => {
  if (!part) return
  if (part.body?.data && !part.filename) {
    if (part.mimeType === 'text/plain') into.text.push(decodeBase64Url(part.body.data))
    else if (part.mimeType === 'text/html') into.html.push(decodeBase64Url(part.body.data))
  }
  for (const child of (part.parts ?? []) as BodyPart[]) collect(child, into)
}

export const htmlToText = (html: string): string =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** An allow-nothing-dangerous pass over sender HTML, run before storage.
 *
 *  Deliberately not a general-purpose sanitiser: the rendering side puts this in
 *  an iframe with an empty sandbox and no network for images until asked, so this
 *  is the second of two defences rather than the only one. What it removes is what
 *  is dangerous even inside a sandbox or if the sandbox is ever weakened: script
 *  and style elements, event handlers, javascript: and data: URLs, forms, frames,
 *  and anything that navigates the parent. */
export const sanitiseHtml = (html: string): string =>
  html
    .replace(/<\s*(script|style|iframe|frame|frameset|object|embed|applet|form|base|meta|link)\b[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|frame|frameset|object|embed|applet|form|base|meta|link)\b[^>]*\/?>/gi, '')
    // on* handlers, quoted or bare.
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    // Anything that would run or smuggle code through an attribute value.
    .replace(/(href|src|action|formaction|xlink:href)\s*=\s*"(?:\s*)(javascript|vbscript|data):[^"]*"/gi, '$1="#"')
    .replace(/(href|src|action|formaction|xlink:href)\s*=\s*'(?:\s*)(javascript|vbscript|data):[^']*'/gi, "$1='#'")
    .replace(/\ssrcdoc\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .trim()

// ------------------------------------------------------------------ sync

export type SyncOutcome = {
  read: number
  /** Newly written. A message already read on an earlier pass counts as neither
   *  stored nor skipped, because "3 stored" when nothing changed is a lie. */
  stored: number
  alreadyHad: number
  skipped: number
  done: boolean
  reason: string | null
}

/** One pass. The caller schedules it; this decides whether the pass is a back-fill
 *  page or an incremental catch-up, does the work, and moves the cursor.
 *
 *  Back-fill is oldest-first with the page token persisted, so an interrupted run
 *  resumes rather than restarting, and provider_message_id being unique per
 *  workspace means a re-read writes nothing twice. B2. */
export const syncMailbox = async (
  ctx: WorkspaceContext,
  mailboxId: string,
): Promise<SyncOutcome> => {
  const box = await readMailbox(ctx, mailboxId)
  if (!box) throw new Error('That mailbox is not connected.')
  if (ctx.actorKind === 'user' && ctx.role !== 'admin' && box.userId !== ctx.actorId) {
    throw new Error('That is somebody else’s mailbox. Only they, or an admin, can run its sync.')
  }
  if (box.state === 'revoked') {
    return { read: 0, stored: 0, alreadyHad: 0, skipped: 0, done: true, reason: 'Access to this mailbox was withdrawn.' }
  }
  if (box.state === 'paused') {
    return { read: 0, stored: 0, alreadyHad: 0, skipped: 0, done: true, reason: 'This mailbox is paused.' }
  }

  const blocked = await blockedPatterns(ctx, box.userId)
  const internalDomain = await internalDomainOf(ctx)

  try {
    const { fetcher } = devGmailEnabled
      ? { fetcher: devFetcher(box.email, internalDomain) }
      : await authorised(ctx, mailboxId, box)

    const outcome = box.backfillDone
      ? await incremental(ctx, box, fetcher, { internalDomain, blocked })
      : await backfill(ctx, box, fetcher, { internalDomain, blocked })

    return outcome
  } catch (cause) {
    const revoked = cause instanceof RevokedError
    await recordMailboxFailure(
      ctx,
      mailboxId,
      cause instanceof Error ? cause.message : String(cause),
      revoked,
    )
    throw cause
  }
}

type Options = { internalDomain: string; blocked: Set<string> }

type Tally = { stored: number; alreadyHad: number; skipped: number }

const store = async (
  ctx: WorkspaceContext,
  box: { id: string; email: string },
  incoming: IncomingMessage,
  options: Options,
  tally: Tally,
): Promise<void> => {
  const result = await ingestMessage(ctx, {
    incoming,
    ownerEmail: box.email,
    mailboxId: box.id,
    internalDomain: options.internalDomain,
    blocked: options.blocked,
  })
  if (!result.stored) tally.skipped += 1
  else if (result.created) tally.stored += 1
  else tally.alreadyHad += 1
}

const backfill = async (
  ctx: WorkspaceContext,
  box: { id: string; email: string; backfillCursor: string | null },
  fetcher: Fetcher,
  options: Options,
): Promise<SyncOutcome> => {
  const list = (await fetcher('/messages', {
    maxResults: String(PAGE_SIZE),
    ...(box.backfillCursor ? { pageToken: box.backfillCursor } : {}),
  })) as { messages?: { id: string }[]; nextPageToken?: string }

  const tally: Tally = { stored: 0, alreadyHad: 0, skipped: 0 }
  for (const stub of list.messages ?? []) {
    // One read, not two: metadata now and the body later cost two requests per
    // message against the same quota, and left every thread unreadable in between.
    const raw = (await fetcher(`/messages/${stub.id}`, { format: 'full' })) as GmailMessage
    const incoming = toIncoming(raw)
    if (!incoming) {
      tally.skipped += 1
      continue
    }
    await store(ctx, box, incoming, options, tally)
  }

  const done = !list.nextPageToken
  await updateMailboxCursor(ctx, box.id, {
    backfillCursor: list.nextPageToken ?? null,
    backfillDone: done,
    // The first incremental pass needs a starting historyId, and the profile is
    // where Gmail publishes it.
    ...(done ? { historyId: await currentHistoryId(fetcher), state: 'connected' as const } : {}),
  })

  return {
    read: (list.messages ?? []).length,
    ...tally,
    done,
    reason: done ? null : 'More history to read; the next pass continues from here.',
  }
}

const currentHistoryId = async (fetcher: Fetcher): Promise<string | null> => {
  const profile = (await fetcher('/profile')) as { historyId?: string }
  return profile.historyId ?? null
}

const incremental = async (
  ctx: WorkspaceContext,
  box: { id: string; email: string; historyId: string | null },
  fetcher: Fetcher,
  options: Options,
): Promise<SyncOutcome> => {
  if (!box.historyId) {
    // Nothing to be incremental from. Restart the back-fill rather than guessing.
    await updateMailboxCursor(ctx, box.id, { backfillDone: false, backfillCursor: null })
    return { read: 0, stored: 0, alreadyHad: 0, skipped: 0, done: false, reason: 'No history cursor, so the full read starts again.' }
  }

  let history: { history?: { messagesAdded?: { message: GmailMessage }[] }[]; historyId?: string }
  try {
    history = (await fetcher('/history', {
      startHistoryId: box.historyId,
      historyTypes: 'messageAdded',
    })) as typeof history
  } catch (cause) {
    // An expired historyId is a 404. Google says so in the documentation, and the
    // answer is a full re-list, not a crash. B2.
    if ((cause as { status?: number }).status === 404) {
      await updateMailboxCursor(ctx, box.id, { backfillDone: false, backfillCursor: null, historyId: null })
      return {
        read: 0,
        stored: 0,
        alreadyHad: 0,
        skipped: 0,
        done: false,
        reason: 'The history cursor had aged out, so the full read starts again. Nothing is duplicated.',
      }
    }
    throw cause
  }

  const tally: Tally = { stored: 0, alreadyHad: 0, skipped: 0 }
  let read = 0
  for (const entry of history.history ?? []) {
    for (const added of entry.messagesAdded ?? []) {
      read += 1
      const raw = (await fetcher(`/messages/${added.message.id}`, { format: 'full' })) as GmailMessage
      const incoming = toIncoming(raw)
      if (!incoming) {
        tally.skipped += 1
        continue
      }
      await store(ctx, box, incoming, options, tally)
    }
  }

  await updateMailboxCursor(ctx, box.id, {
    historyId: history.historyId ?? box.historyId,
    state: 'connected',
  })

  return { read, ...tally, done: true, reason: null }
}


// --------------------------------------------------------------- hydrate

/** Fetches the bodies of messages stored without one and writes them here, so a
 *  thread stays readable after the mailbox that read it is disconnected. Run by
 *  `mail.hydrate`, a page at a time, oldest backlog first.
 *
 *  A message whose mailbox can no longer fetch it is marked failed with the reason
 *  rather than retried for ever: the queue has to drain. */
export const hydrateMailboxBodies = async (
  ctx: WorkspaceContext,
  mailboxId: string,
  limit = 50,
): Promise<{ stored: number; failed: number; remaining: boolean }> => {
  const box = await readMailbox(ctx, mailboxId)
  if (!box) throw new Error('That mailbox is not connected.')

  const pending = await pendingBodies(ctx, mailboxId, limit)
  if (pending.length === 0) return { stored: 0, failed: 0, remaining: false }

  if (box.state === 'revoked') {
    for (const row of pending) {
      await failBody(ctx, row.id, 'The mailbox that read this message is no longer connected.')
    }
    return { stored: 0, failed: pending.length, remaining: true }
  }

  const { fetcher } = devGmailEnabled
    ? { fetcher: devFetcher(box.email, await internalDomainOf(ctx)) }
    : await authorised(ctx, box.id, box)

  let stored = 0
  let failed = 0
  for (const row of pending) {
    try {
      const raw = (await fetcher(`/messages/${row.providerMessageId}`, { format: 'full' })) as GmailMessage
      const found = { text: [] as string[], html: [] as string[] }
      collect(raw.payload as BodyPart | undefined, found)
      const text = found.text.length > 0 ? found.text.join('\n').trim() : htmlToText(found.html.join('\n'))
      const html = found.html.length > 0 ? sanitiseHtml(found.html.join('\n')) : null
      await storeBody(ctx, row.id, {
        text: text || raw.snippet || '(this message has no readable text)',
        html,
      })
      stored += 1
    } catch (cause) {
      if (cause instanceof RevokedError) throw cause
      await failBody(ctx, row.id, cause instanceof Error ? cause.message : String(cause))
      failed += 1
    }
  }

  return { stored, failed, remaining: pending.length === limit }
}

// ------------------------------------------------------- development only

/** A stand-in Gmail so the whole path — back-fill, cursor, participant matching,
 *  blocklist, incremental catch-up, revocation — is exercisable before open item 3
 *  lands. Same shape as the real API, five fixed messages, no network. */
const devFetcher = (ownerEmail: string, internalDomain: string): Fetcher => {
  const day = 24 * 60 * 60 * 1000
  const now = Date.now()
  const messages: GmailMessage[] = [
    devMessage('dev-1', 'dev-t1', 'Trial questions', `priya@acme-booking.test`, ownerEmail, now - 9 * day),
    devMessage('dev-2', 'dev-t1', 'Re: Trial questions', ownerEmail, 'priya@acme-booking.test', now - 8 * day),
    devMessage('dev-3', 'dev-t2', 'Pricing', 'newperson@partner1.example', ownerEmail, now - 5 * day),
    // Internal only: must never be stored. B3.
    devMessage('dev-4', 'dev-t3', 'Lunch', `someone@${internalDomain}`, ownerEmail, now - 3 * day),
    // Personal domain: must never be stored. B3.
    devMessage('dev-5', 'dev-t4', 'Hello', 'someone@gmail.com', ownerEmail, now - 2 * day),
  ]

  return async (path, params, send) => {
    if (path === '/messages/send' && send) {
      // Accepted and dropped. Everything downstream of the send is real: the row,
      // the tokens, the advance, the pixel and the click all work against this.
      const id = `dev-sent-${Math.random().toString(36).slice(2, 10)}`
      console.log(`[gmail:dev] pretending to send ${id}`)
      return { id, threadId: 'dev-sent-thread' }
    }
    if (path === '/profile') return { historyId: '1000' }
    if (path === '/messages') {
      const from = params?.pageToken ? Number(params.pageToken) : 0
      const size = Number(params?.maxResults ?? PAGE_SIZE)
      const page = messages.slice(from, from + size)
      const next = from + size < messages.length ? String(from + size) : undefined
      return { messages: page.map((entry) => ({ id: entry.id })), ...(next ? { nextPageToken: next } : {}) }
    }
    if (path === '/history') return { history: [], historyId: '1000' }
    const id = path.replace('/messages/', '')
    const found = messages.find((entry) => entry.id === id)
    if (!found) throw new Error(`The development mailbox has no message ${id}.`)
    if (params?.format !== 'full') return found
    const subject = found.payload?.headers?.find((h) => h.name === 'Subject')?.value ?? ''
    const body = `Hi,\n\nThis is the full body of "${subject}" from the development mailbox. It exists so the thread viewer, the on-demand fetch and the MCP tool are all exercisable before a real mailbox is connected.\n\nThanks,\nDev`
    return {
      ...found,
      payload: {
        ...found.payload,
        mimeType: 'text/plain',
        body: { data: Buffer.from(body, 'utf8').toString('base64url') },
      },
    }
  }
}

const devMessage = (
  id: string,
  threadId: string,
  subject: string,
  from: string,
  to: string,
  at: number,
): GmailMessage => ({
  id,
  threadId,
  internalDate: String(at),
  snippet: `${subject} — development mailbox`,
  payload: {
    headers: [
      { name: 'Subject', value: subject },
      { name: 'From', value: from },
      { name: 'To', value: to },
      { name: 'Message-ID', value: `<${id}@development.invalid>` },
      // The second message in a thread answers the first, which is what makes
      // reply detection exercisable here.
      ...(subject.startsWith('Re: ') ? [{ name: 'In-Reply-To', value: '<dev-1@development.invalid>' }] : []),
    ],
  },
})

/** A fetcher bound to one mailbox, for anything outside this module that needs to
 *  talk to Gmail as that person: the sequence sender, and one-off replies. */
export const gmailFetcherFor = async (
  ctx: WorkspaceContext,
  mailboxId: string,
): Promise<(path: string, params?: Record<string, string>, send?: { method: 'POST'; body: string }) => Promise<unknown>> => {
  const box = await readMailbox(ctx, mailboxId)
  if (!box) throw new Error('That mailbox is not connected.')
  if (box.state === 'revoked') {
    throw new RevokedError('Access to this mailbox has been withdrawn in the Google account.')
  }
  if (devGmailEnabled) return devFetcher(box.email, await internalDomainOf(ctx))
  const { fetcher } = await authorised(ctx, box.id, box)
  return fetcher
}

export const gmailConfigured = googleConfigured || devGmailEnabled

