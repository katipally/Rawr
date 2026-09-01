import {
  blockedPatterns,
  ingestMessage,
  internalDomainOf,
  readMailbox,
  recordMailboxFailure,
  updateMailboxCursor,
  type IncomingMessage,
  type WorkspaceContext,
} from '@rawr/db'
import { devGmailEnabled, googleConfigured } from '~/lib/env.ts'
import { googleClient } from './auth/google.ts'

/** F1 phase B. Gmail, read only. D7: `gmail.readonly` and nothing else, because
 *  nobody asked to send from Rawr, Apollo already sends with tracking, and every
 *  extra scope widens the blast radius of a leaked token for no gain. */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

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

type Fetcher = (path: string, params?: Record<string, string>) => Promise<unknown>

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

  const fetcher: Fetcher = async (path, params) => {
    const url = new URL(`${API}${path}`)
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value)

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
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
  body?: { attachmentId?: string; size?: number }
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

export const toIncoming = (raw: GmailMessage): IncomingMessage | null => {
  const headers = raw.payload?.headers ?? []
  const from = parseAddresses(headerValue(headers, 'From'))[0]
  if (!raw.id || !raw.threadId || !from) return null

  return {
    providerThreadId: raw.threadId,
    providerMessageId: raw.id,
    subject: headerValue(headers, 'Subject') || null,
    from,
    to: parseAddresses(headerValue(headers, 'To')),
    cc: parseAddresses(headerValue(headers, 'Cc')),
    sentAt: new Date(Number(raw.internalDate ?? Date.now())),
    snippet: raw.snippet ?? null,
    // Bodies are stored by reference, never inline, so a 20MB thread does not
    // bloat the table. Until an object store is configured, the reference is the
    // provider's own id, which is enough to fetch it again. B1.
    bodyRef: `gmail:${raw.id}`,
    hasAttachments: hasAttachment(raw.payload),
  }
}

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
  box: { email: string },
  incoming: IncomingMessage,
  options: Options,
  tally: Tally,
): Promise<void> => {
  const result = await ingestMessage(ctx, {
    incoming,
    ownerEmail: box.email,
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
    const raw = (await fetcher(`/messages/${stub.id}`, { format: 'metadata' })) as GmailMessage
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
      const raw = (await fetcher(`/messages/${added.message.id}`, { format: 'metadata' })) as GmailMessage
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

  return async (path, params) => {
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
    return found
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
    ],
  },
})

export const gmailConfigured = googleConfigured || devGmailEnabled

