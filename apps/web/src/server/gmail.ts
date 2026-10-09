import {
  acknowledgeThreadPush,
  acknowledgeUnreadPush,
  blockedPatterns,
  folderChanges,
  gmailLabelsFor,
  isAdmin,
  failBody,
  ingestMessage,
  internalDomainOf,
  labelsOfThread,
  markMailboxCannotModify,
  notify,
  pendingBodies,
  readMailbox,
  reconcileThreadFolders,
  recordMailboxFailure,
  storeBody,
  threadPushPlan,
  threadStateFromLabels,
  updateMailboxCursor,
  withAccount,
  DEV_ACCESS_TOKEN,
  type IncomingAttachment,
  type IncomingMessage,
  type AccountContext,
  type ThreadPush,
} from '@rawr/db'
import { devGmailEnabled, googleConfigured } from '~/lib/env.ts'
import { googleRefresher, OAuth2RequestError } from './auth/google.ts'
import { isRateLimited, sendWithBackoff } from './integrations/provider.ts'
import { sanitiseHtml } from './mail-html.ts'

const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'

/** Reading is what every mailbox is connected for. `gmail.modify` is asked with it
 *  because Archive, Trash and Mark unread have to reach Gmail; it is the narrowest
 *  scope that changes labels and the Trash. Nothing else is asked for on connect. */
export const GMAIL_READ_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', MODIFY_SCOPE]

/** Sending is asked for separately and only by somebody who wants sequences sent
 *  as themselves. `gmail.send` can only send: it cannot read, modify or delete.
 *
 *  A mailbox connected before this existed keeps reading and cannot send until
 *  its owner reconnects and grants it, which is the honest way round. */
export const GMAIL_SEND_SCOPES = [...GMAIL_READ_SCOPES, 'https://www.googleapis.com/auth/gmail.send']

const isDevMailbox = (box: { accessToken: string }): boolean =>
  devGmailEnabled && box.accessToken === DEV_ACCESS_TOKEN

/** Whether what Google actually granted includes sending. Read from the token's
 *  own scope list rather than from what was asked for, because a person can
 *  untick one on the consent screen. */
export const grantedSending = (scopes: string[]): boolean =>
  scopes.includes('https://www.googleapis.com/auth/gmail.send')

/** Whether Google granted gmail.modify. Stored on the mailbox, so the thread can say
 *  a reconnect is needed without asking Google each time. */
export const grantedModifying = (scopes: string[]): boolean => scopes.includes(MODIFY_SCOPE)

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** The address Google actually authorised. `login_hint` only suggests an account
 *  on the consent screen, so the person can pick another, and the session's email
 *  is then the wrong name for the mail that comes in. */
export const authorisedAddress = async (accessToken: string): Promise<string> => {
  const response = await sendWithBackoff(
    () => fetch(`${API}/profile`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) }),
    { repeatable: true },
  )
  const profile = (await response.json().catch(() => null)) as { emailAddress?: string } | null
  if (!response.ok || !profile?.emailAddress) {
    throw new Error(`Gmail would not say which address was connected (${response.status}).`)
  }
  return profile.emailAddress
}

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

/** A grant Google has withdrawn, wherever it is found.
 *
 *  Every path that finds one has to mark the mailbox, not only the sync. A send or
 *  a body fetch that leaves the row reading 'connected' is asked again on the next
 *  tick, for ever, because the dispatchers select on that column.
 *
 *  And the owner is the only person who can grant it again, so they are told.
 *  Keyed on the mailbox, so one withdrawal is one notice however many enrollments
 *  and bodies run into it. */
const recordRevocation = async (
  ctx: AccountContext,
  box: { id: string; userId: string; email: string },
  message: string,
): Promise<void> => {
  await recordMailboxFailure(ctx, box.id, message, true)
  await withAccount(ctx, (tx) =>
    notify(tx, ctx, {
      kind: 'mailbox_revoked',
      dedupeKey: `mailbox_revoked:${box.id}`,
      title: `${box.email} is no longer connected`,
      body: 'Google withdrew Rawr’s access, so nothing is read or sent from it until you connect it again.',
      to: { userIds: [box.userId] },
    }),
  )
}

type GmailError = Error & { status?: number; transient?: boolean }

/** Whether a failure is Google being busy or unreachable rather than refusing the
 *  request, which is the difference between trying again later and giving up. */
export const isTransient = (cause: unknown): boolean =>
  (cause as GmailError).transient === true ||
  (cause as Error).name === 'TimeoutError' ||
  (cause instanceof TypeError && cause.message === 'fetch failed') ||
  (cause instanceof OAuth2RequestError && /^http_5/.test(cause.code))

/** Google refused a call because the grant lacks a scope it needs. The grant itself is
 *  fine, so this is not a revocation: the change stays in Rawr and the mailbox is asked
 *  to reconnect. The body wording is inferred from Google's usual error reason; it is
 *  not in the Gmail error reference, so a real account has to confirm it. */
export class ScopeShortfall extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopeShortfall'
  }
}

const isScopeShortfall = (status: number, body: string): boolean =>
  status === 403 && /insufficient(permission|authentication)/i.test(body)

/** Google's own signal that the grant is gone. Anything else is a transient error
 *  and is retried; this one stops the mailbox, because a withdrawn consent does
 *  not come back on its own and retrying would be the wrong answer to it. */
const isRevocation = (status: number, body: string): boolean =>
  status === 401 ||
  (status === 403 && /insufficient|forbidden|scope/i.test(body)) ||
  /invalid_grant/i.test(body)

export type Fetcher = (
  path: string,
  params?: Record<string, string | string[]>,
  /** Set to POST a body. Reads pass neither and get a GET, which is every call
   *  this module made before sending existed. */
  send?: { method: 'POST'; body: string },
) => Promise<unknown>

/** Refreshes the access token when it is within a minute of expiry, and again once
 *  on a 401 for one that expired mid-pass: a back-fill page is fifty sequential
 *  reads, so a token can lapse part way through. Each new one is stored. */
export const authorised = async (
  ctx: AccountContext,
  mailboxId: string,
  tokens: { accessToken: string; refreshToken: string; accessTokenExpiresAt: Date | null },
  persist: typeof updateMailboxCursor = updateMailboxCursor,
): Promise<{ fetcher: Fetcher; accessToken: string }> => {
  let accessToken = tokens.accessToken

  const refresh = async (): Promise<void> => {
    try {
      const refreshed = await googleRefresher().refreshAccessToken(tokens.refreshToken)
      accessToken = refreshed.accessToken()
      await persist(ctx, mailboxId, {
        accessToken,
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt(),
      })
    } catch (cause) {
      // Only invalid_grant says Google withdrew the grant. A timeout, a 5xx or a
      // DNS failure says nothing about it, and treating one as revocation stops
      // the mailbox and tells its owner to reconnect over something a retry fixes.
      if (cause instanceof OAuth2RequestError && cause.code === 'invalid_grant') {
        throw new RevokedError(`Google refused to refresh this mailbox's access: ${cause.message}`)
      }
      throw cause
    }
  }

  const expiring = tokens.accessTokenExpiresAt && tokens.accessTokenExpiresAt.getTime() - Date.now() < 60_000
  if (expiring && googleConfigured) await refresh()

  const fetcher: Fetcher = async (path, params, send) => {
    const url = new URL(`${API}${path}`)
    for (const [key, value] of Object.entries(params ?? {})) {
      for (const item of [value].flat()) url.searchParams.append(key, item)
    }

    // A send is not repeated on a 5xx: Gmail takes no idempotency key, so a
    // failure after it acted would put the mail in the inbox twice.
    const request = () =>
      sendWithBackoff(
        () =>
          fetch(url, {
            method: send?.method ?? 'GET',
            headers: {
              authorization: `Bearer ${accessToken}`,
              ...(send ? { 'content-type': 'application/json' } : {}),
            },
            ...(send ? { body: send.body } : {}),
            // Sending is slower than reading, and a timeout here means a mail that may
            // or may not have gone out, so it is given longer.
            signal: AbortSignal.timeout(send ? 45_000 : 20_000),
          }),
        { repeatable: !send },
      )

    let response = await request()
    if (response.status === 401 && googleConfigured) {
      await refresh()
      response = await request()
    }
    if (response.ok) return response.json()

    const body = await response.text()
    if (isScopeShortfall(response.status, body)) throw new ScopeShortfall(`Gmail needs a permission this mailbox was not given: ${body.slice(0, 200)}`)
    if (!isRateLimited(response.status, body) && isRevocation(response.status, body)) {
      throw new RevokedError('Access to this mailbox has been withdrawn in the Google account.')
    }
    // A 404 on history.list means the stored historyId has aged out. The caller
    // turns that into a full re-list rather than a crash. B2.
    const error = new Error(`Gmail answered ${response.status}: ${body.slice(0, 300)}`)
    ;(error as GmailError).status = response.status
    ;(error as GmailError).transient = isRateLimited(response.status, body) || response.status >= 500
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
    bcc: parseAddresses(headerValue(headers, 'Bcc')),
    replyTo: parseAddresses(headerValue(headers, 'Reply-To')),
    sentAt: new Date(Number(raw.internalDate ?? Date.now())),
    snippet: raw.snippet ?? null,
    internetMessageId: messageIds(headerValue(headers, 'Message-ID'))[0] ?? null,
    inReplyTo: messageIds(headerValue(headers, 'In-Reply-To'))[0] ?? null,
    references: messageIds(headerValue(headers, 'References')),
    body,
    headers: Object.fromEntries(headers.map((header) => [header.name?.toLowerCase() ?? '', header.value])),
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
 *  Back-fill is newest-first, as Gmail lists, with the page token persisted, so an interrupted run
 *  resumes rather than restarting, and provider_message_id being unique per
 *  account means a re-read writes nothing twice. B2. */
export const syncMailbox = async (
  ctx: AccountContext,
  mailboxId: string,
): Promise<SyncOutcome> => {
  const box = await readMailbox(ctx, mailboxId)
  if (!box) throw new Error('That mailbox is not connected.')
  if (ctx.actorKind === 'user' && !isAdmin(ctx) && box.userId !== ctx.actorId) {
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
    const { fetcher } = isDevMailbox(box)
      ? { fetcher: devFetcher(box.email, internalDomain) }
      : await authorised(ctx, mailboxId, box)

    const outcome = box.backfillDone
      ? await incremental(ctx, box, fetcher, { internalDomain, blocked })
      : await backfill(ctx, box, fetcher, { internalDomain, blocked })

    return outcome
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (cause instanceof RevokedError) await recordRevocation(ctx, box, message)
    else await recordMailboxFailure(ctx, mailboxId, message, false)
    throw cause
  }
}

type Options = { internalDomain: string; blocked: Set<string> }

/** One message, or null if Gmail no longer has it. A message can be deleted
 *  between the list that named it and the read of it, and that 404 is one message
 *  gone rather than a broken mailbox: the pass skips it and carries on. Only a 404
 *  from history.list means the cursor aged out. */
const fetchMessage = async (fetcher: Fetcher, id: string): Promise<GmailMessage | null> => {
  try {
    return (await fetcher(`/messages/${id}`, { format: 'full' })) as GmailMessage
  } catch (cause) {
    if ((cause as { status?: number }).status === 404) return null
    throw cause
  }
}

type Tally = { stored: number; alreadyHad: number; skipped: number }

const store = async (
  ctx: AccountContext,
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
  if (result.stored && result.createdContactIds.length > 0) {
    // Loaded here, not at the top: record-events reaches next/server through automations, which plain Node unit tests cannot load.
    const { recordsCreated } = await import('./record-events.ts')
    await recordsCreated(ctx, 'contact', result.createdContactIds)
  }
}

/** Bulk mail that never touches a record. Left out of the list so a large mailbox
 *  is not read page by page only to be thrown away, at about five quota units a
 *  message. Not `updates`, where receipts live but so can a person's notices. */
const BACKFILL_QUERY = '-category:promotions -category:social -category:forums'

const backfill = async (
  ctx: AccountContext,
  box: { id: string; email: string; backfillCursor: string | null; historyId: string | null },
  fetcher: Fetcher,
  options: Options,
): Promise<SyncOutcome> => {
  // Read before the first page, because the list is a snapshot of the mailbox as
  // it was then: mail that arrives while the back-fill runs is in no later page,
  // and a cursor taken at the end would step over it.
  const startedAt = box.backfillCursor ? null : await currentHistoryId(fetcher)

  const list = (await fetcher('/messages', {
    maxResults: String(PAGE_SIZE),
    q: BACKFILL_QUERY,
    ...(box.backfillCursor ? { pageToken: box.backfillCursor } : {}),
  })) as { messages?: { id: string }[]; nextPageToken?: string }

  const tally: Tally = { stored: 0, alreadyHad: 0, skipped: 0 }
  for (const stub of list.messages ?? []) {
    // One read, not two: metadata now and the body later cost two requests per
    // message against the same quota, and left every thread unreadable in between.
    const raw = await fetchMessage(fetcher, stub.id)
    const incoming = raw && toIncoming(raw)
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
    // A back-fill begun before this was taken at the start has no cursor yet, and
    // the profile is where Gmail publishes the current one.
    ...(startedAt || (done && !box.historyId)
      ? { historyId: startedAt ?? (await currentHistoryId(fetcher)) }
      : {}),
    state: done ? 'connected' : 'backfilling',
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

type HistoryMessage = { id?: string; threadId?: string }
type HistoryPage = {
  history?: {
    id?: string
    messagesAdded?: { message: HistoryMessage }[]
    labelsAdded?: { message: HistoryMessage; labelIds?: string[] }[]
    labelsRemoved?: { message: HistoryMessage; labelIds?: string[] }[]
  }[]
  nextPageToken?: string
  historyId?: string
}

/** Only a label change to the Inbox or to Trash moves a thread in Rawr. Read state and
 *  the other labels are not read back. */
const FOLDER_LABELS = ['INBOX', 'TRASH']

/** Pages per pass. A mailbox that was away for days can owe thousands of records,
 *  and a pass has to end inside the worker's timeout. */
const HISTORY_PAGES_PER_PASS = 5

/** Every message added since `startHistoryId`, following `nextPageToken`, and the
 *  cursor to continue from. A history list is a hundred records a page, so reading
 *  one page and moving the cursor to the mailbox's head loses everything past it.
 *
 *  `threadIds` are the threads whose Inbox or Trash label changed in Gmail: archiving
 *  in Gmail is a label removal, so it arrives here and nowhere else.
 *
 *  When the page limit stops the read, the cursor is the last record read rather
 *  than the head, and `more` says to come back. Null is an expired cursor: Gmail
 *  answers 404 once the history has aged out, which means a full re-list. */
export const collectHistory = async (
  fetcher: Fetcher,
  startHistoryId: string,
): Promise<{ ids: string[]; threadIds: string[]; cursor: string; more: boolean } | null> => {
  const ids = new Set<string>()
  const threadIds = new Set<string>()
  let cursor = startHistoryId
  let pageToken: string | undefined

  for (let page = 1; ; page++) {
    let result: HistoryPage
    try {
      result = (await fetcher('/history', {
        startHistoryId,
        historyTypes: ['messageAdded', 'labelAdded', 'labelRemoved'],
        ...(pageToken ? { pageToken } : {}),
      })) as HistoryPage
    } catch (cause) {
      if ((cause as { status?: number }).status === 404) return null
      throw cause
    }

    const records = result.history ?? []
    for (const record of records) {
      for (const added of record.messagesAdded ?? []) if (added.message.id) ids.add(added.message.id)
      for (const change of [...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])]) {
        const folder = (change.labelIds ?? []).some((label) => FOLDER_LABELS.includes(label))
        if (folder && change.message.threadId) threadIds.add(change.message.threadId)
      }
    }

    pageToken = result.nextPageToken
    if (!pageToken) return { ids: [...ids], threadIds: [...threadIds], cursor: result.historyId ?? cursor, more: false }
    cursor = records.at(-1)?.id ?? cursor
    if (page === HISTORY_PAGES_PER_PASS) return { ids: [...ids], threadIds: [...threadIds], cursor, more: true }
  }
}

/** A thread's folders as Gmail has them now. The read is stamped before the call, so a
 *  Rawr change made after it is never overwritten by what Gmail said before. */
const readBackFolders = async (ctx: AccountContext, fetcher: Fetcher, threadId: string): Promise<void> => {
  const readAt = new Date()
  let thread: { messages?: { labelIds?: string[] }[] }
  try {
    thread = (await fetcher(`/threads/${threadId}`, { format: 'minimal' })) as typeof thread
  } catch (cause) {
    if ((cause as { status?: number }).status === 404) return
    throw cause
  }
  const labels = (thread.messages ?? []).map((message) => message.labelIds ?? [])
  if (labels.length === 0) return
  await reconcileThreadFolders(ctx, threadId, threadStateFromLabels(labels), readAt)
}

const incremental = async (
  ctx: AccountContext,
  box: { id: string; email: string; historyId: string | null },
  fetcher: Fetcher,
  options: Options,
): Promise<SyncOutcome> => {
  if (!box.historyId) {
    // Nothing to be incremental from. Restart the back-fill rather than guessing.
    await updateMailboxCursor(ctx, box.id, { backfillDone: false, backfillCursor: null })
    return { read: 0, stored: 0, alreadyHad: 0, skipped: 0, done: false, reason: 'No history cursor, so the full read starts again.' }
  }

  const added = await collectHistory(fetcher, box.historyId)
  if (!added) {
    // An expired historyId is a 404. Google says so in the documentation, and the
    // answer is a full re-list, not a crash. B2.
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

  const tally: Tally = { stored: 0, alreadyHad: 0, skipped: 0 }
  for (const id of added.ids) {
    const raw = await fetchMessage(fetcher, id)
    const incoming = raw && toIncoming(raw)
    if (!incoming) {
      tally.skipped += 1
      continue
    }
    await store(ctx, box, incoming, options, tally)
  }

  for (const threadId of added.threadIds) await readBackFolders(ctx, fetcher, threadId)

  await updateMailboxCursor(ctx, box.id, { historyId: added.cursor, state: 'connected' })

  return {
    read: added.ids.length,
    ...tally,
    done: !added.more,
    reason: added.more ? 'More recent mail to read; the next pass continues from here.' : null,
  }
}

// --------------------------------------------------------------- hydrate

/** Fetches the bodies of messages stored without one and writes them here, so a
 *  thread stays readable after the mailbox that read it is disconnected. Run by
 *  `mail.hydrate`, a page at a time, oldest backlog first.
 *
 *  A message whose mailbox can no longer fetch it is marked failed with the reason
 *  rather than retried for ever: the queue has to drain. */
export const hydrateMailboxBodies = async (
  ctx: AccountContext,
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

  const { fetcher } = isDevMailbox(box)
    ? { fetcher: devFetcher(box.email, await internalDomainOf(ctx)) }
    : await guarding(ctx, box, () => authorised(ctx, box.id, box))

  let stored = 0
  let failed = 0
  for (const row of pending) {
    try {
      const raw = await fetchMessage(fetcher, row.providerMessageId)
      if (!raw) {
        await failBody(ctx, row.id, 'Gmail no longer has this message, so its body cannot be read.')
        failed += 1
        continue
      }
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
      if (cause instanceof RevokedError) {
        await recordRevocation(ctx, box, cause.message)
        throw cause
      }
      await failBody(ctx, row.id, cause instanceof Error ? cause.message : String(cause))
      failed += 1
    }
  }

  return { stored, failed, remaining: pending.length === limit }
}

// ------------------------------------------------------------- push

const EMPTY_POST = { method: 'POST' as const, body: '{}' }

/** Brings a thread's folders in Gmail to what Rawr says: Trash, then the Inbox label.
 *  Reads Gmail first and sends only what differs, so running it again changes nothing. */
const applyFolders = async (fetcher: Fetcher, plan: ThreadPush): Promise<void> => {
  const path = `/threads/${plan.providerThreadId}`
  let thread: { messages?: { labelIds?: string[] }[] }
  try {
    thread = (await fetcher(path, { format: 'minimal' })) as typeof thread
  } catch (cause) {
    // The thread is gone from Gmail, so there is nothing left to move.
    if ((cause as GmailError).status === 404) return
    throw cause
  }
  const inGmail = labelsOfThread((thread.messages ?? []).map((message) => message.labelIds ?? []))
  const change = folderChanges(inGmail, gmailLabelsFor({ archived: plan.archived, trashed: plan.trashed }))
  if (change.trash) await fetcher(`${path}/trash`, undefined, EMPTY_POST)
  if (change.untrash) await fetcher(`${path}/untrash`, undefined, EMPTY_POST)
  if (change.addInbox || change.removeInbox) {
    await fetcher(`${path}/modify`, undefined, {
      method: 'POST',
      body: JSON.stringify({
        addLabelIds: change.addInbox ? ['INBOX'] : [],
        removeLabelIds: change.removeInbox ? ['INBOX'] : [],
      }),
    })
  }
}

/** Sets the UNREAD label on one person's copy of the thread. A thread Gmail no longer
 *  has is nothing to mark. */
const applyUnread = async (fetcher: Fetcher, providerThreadId: string, wanted: boolean): Promise<void> => {
  try {
    await fetcher(`/threads/${providerThreadId}/modify`, undefined, {
      method: 'POST',
      body: JSON.stringify(wanted ? { addLabelIds: ['UNREAD'] } : { removeLabelIds: ['UNREAD'] }),
    })
  } catch (cause) {
    if ((cause as GmailError).status !== 404) throw cause
  }
}

/** Pushes what Rawr has recorded for a thread to every mailbox that holds it and can
 *  change Gmail. Called by the worker, after the change itself is already saved.
 *
 *  A mailbox that cannot change Gmail is passed over and the thread is still marked
 *  delivered: the reconnect requeues it (requeueThreadsOfMailbox), so nothing is lost
 *  and nothing is retried forever. A transient failure is thrown, and the job retries
 *  the whole thread, which is safe because every step reads Gmail before it writes. */
export const pushThreadToGmail = async (ctx: AccountContext, threadId: string): Promise<void> => {
  const plan = await threadPushPlan(ctx, threadId)
  if (!plan) return

  for (const holder of plan.mailboxes) {
    if (holder.state === 'revoked' || !holder.canModify) continue
    const tokens = await readMailbox(ctx, holder.id)
    if (!tokens) continue
    try {
      await guarding(ctx, tokens, async () => {
        const { fetcher } = isDevMailbox(tokens)
          ? { fetcher: devFetcher(tokens.email, await internalDomainOf(ctx)) }
          : await authorised(ctx, tokens.id, tokens)
        await applyFolders(fetcher, plan)
        for (const row of plan.unread) {
          if (row.userId !== holder.userId) continue
          await applyUnread(fetcher, plan.providerThreadId, row.wanted)
          await acknowledgeUnreadPush(ctx, threadId, row.userId, row.wanted)
        }
      })
    } catch (cause) {
      if (cause instanceof RevokedError) continue
      if (cause instanceof ScopeShortfall) {
        await markMailboxCannotModify(ctx, holder.id)
        continue
      }
      throw cause
    }
  }

  // A reader whose mailbox does not hold the thread has nothing in Gmail to change.
  for (const row of plan.unread) {
    if (!plan.mailboxes.some((holder) => holder.userId === row.userId)) {
      await acknowledgeUnreadPush(ctx, threadId, row.userId, row.wanted)
    }
  }
  if (plan.version) await acknowledgeThreadPush(ctx, threadId, plan.version)
}

// ------------------------------------------------------- development only

/** A stand-in Gmail so the whole path — back-fill, cursor, participant matching,
 *  blocklist, incremental catch-up, revocation — is exercisable before a Google project
 *  lands. Same shape as the real API, five fixed messages, no network. */
export const devFetcher = (ownerEmail: string, internalDomain: string): Fetcher => {
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
      // A reply stays in its thread; a new mail gets a thread of its own, as Gmail gives.
      const id = `dev-sent-${Math.random().toString(36).slice(2, 10)}`
      const threadId = (JSON.parse(send.body) as { threadId?: string }).threadId ?? id
      console.log(`[gmail:dev] pretending to send ${id}`)
      return { id, threadId }
    }
    // A thread is read as sitting in the Inbox. A change to one is accepted and dropped,
    // the same as a send: what the thread view shows is what Rawr recorded.
    if (path.startsWith('/threads/')) return send ? {} : { messages: [{ labelIds: ['INBOX'] }] }
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
export const gmailFetcherFor = async (ctx: AccountContext, mailboxId: string): Promise<Fetcher> => {
  const box = await readMailbox(ctx, mailboxId)
  if (!box) throw new Error('That mailbox is not connected.')
  if (box.state === 'revoked') {
    throw new RevokedError('Access to this mailbox has been withdrawn in the Google account.')
  }
  if (isDevMailbox(box)) return devFetcher(box.email, await internalDomainOf(ctx))
  // Wrapped rather than handed back bare: the withdrawal usually surfaces on the
  // call itself, long after this function returned, and the sequence dispatcher
  // and the composer both go through here.
  const { fetcher } = await guarding(ctx, box, () => authorised(ctx, box.id, box))
  return (path, params, send) => guarding(ctx, box, () => fetcher(path, params, send))
}

/** Runs one Gmail call and records the mailbox as revoked if that is what it says. */
const guarding = async <T>(
  ctx: AccountContext,
  box: { id: string; userId: string; email: string },
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work()
  } catch (cause) {
    if (cause instanceof RevokedError) await recordRevocation(ctx, box, cause.message)
    throw cause
  }
}



/** One send, safe to ask for again. Gmail takes no idempotency key, and a timeout or
 *  a 5xx does not say whether the mail went, so before such a failure is allowed to
 *  mean "try again" the mailbox is asked whether a message with this Message-ID is
 *  already in it. A refused request (any 4xx) was not sent and is raised as it is. */
export const sendMail = async (
  fetcher: Fetcher,
  mail: { raw: string; threadId: string | null; internetMessageId: string },
): Promise<{ id?: string; threadId?: string }> => {
  try {
    return (await fetcher('/messages/send', undefined, {
      method: 'POST',
      body: JSON.stringify({ raw: mail.raw, ...(mail.threadId ? { threadId: mail.threadId } : {}) }),
    })) as { id?: string; threadId?: string }
  } catch (cause) {
    const status = (cause as GmailError).status
    if (cause instanceof RevokedError || (status !== undefined && status < 500)) throw cause
    const found = (await fetcher('/messages', { q: `rfc822msgid:${mail.internetMessageId}`, maxResults: '1' }).catch(
      () => null,
    )) as { messages?: { id: string; threadId: string }[] } | null
    if (found?.messages?.[0]) return found.messages[0]
    throw cause
  }
}
