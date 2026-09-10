import {
  readGrant,
  systemContext,
  recordGrantFailure,
  saveGrant,
  type HostAvailability,
  type Interval,
  type StoredGrant,
  type AccountContext,
} from '@rawr/db'
import { devCalendarEnabled, googleCalendarConfigured } from '~/lib/env.ts'
import { googleRefresher, OAuth2RequestError, GoogleTokens } from './auth/google.ts'

/** F2 §2. The calendar side of booking: what a host is already committed to, and
 *  writing the event once a booking is confirmed.
 *
 *  Two providers. `google` is the real one. `dev` exists because a Google project has
 *  not landed: it reports no external commitments, so Rawr's own confirmed bookings
 *  are the only busy time, which makes the whole engine exercisable before a Google
 *  project exists. It is unreachable in production.
 *
 *  The rule that runs through all of it: a host whose calendar cannot be read is
 *  unavailable, never free. Failing open double books a real person. */

const GOOGLE_API = 'https://www.googleapis.com/calendar/v3'
const TIMEOUT_MS = 10_000

export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
]

export class CalendarUnavailable extends Error {
  readonly userId: string
  constructor(userId: string, message: string) {
    super(message)
    this.name = 'CalendarUnavailable'
    this.userId = userId
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Refreshed sixty seconds early, because a token that expires mid-request is the
 *  same failure as one that was already expired, and harder to read in a log. */
const REFRESH_MARGIN_MS = 60_000

const accessTokenFor = async (
  ctx: AccountContext,
  grant: StoredGrant,
): Promise<string> => {
  // Keeping a grant current is Rawr's own bookkeeping, whoever happened to ask
  // for a slot. The visitor on a public booking page holds no hub, and the state
  // of the host's connection must not depend on that.
  const system = systemContext(ctx.accountId)

  const fresh =
    grant.accessToken &&
    grant.accessTokenExpiresAt &&
    grant.accessTokenExpiresAt.getTime() - REFRESH_MARGIN_MS > Date.now()
  if (fresh && grant.accessToken) return grant.accessToken

  if (!grant.refreshToken) {
    await recordGrantFailure(system, {
      userId: grant.userId,
      error: 'No refresh token is stored, so this calendar cannot be reconnected without consent.',
      revoked: true,
    })
    throw new CalendarUnavailable(grant.userId, 'That calendar connection has to be re-authorised.')
  }

  // Only Google's refusal is caught: a failure writing the row is not a calendar
  // problem, and recording it as one puts the wrong diagnosis in front of a host.
  let tokens: GoogleTokens
  try {
    tokens = await googleRefresher().refreshAccessToken(grant.refreshToken)
  } catch (cause) {
    // invalid_grant means the person revoked access or changed their password.
    // Retrying that forever is the loop a revoked grant must never become.
    const revoked = cause instanceof OAuth2RequestError && cause.code === 'invalid_grant'
    const message = cause instanceof Error ? cause.message : String(cause)
    await recordGrantFailure(system, { userId: grant.userId, error: message, revoked })
    throw new CalendarUnavailable(
      grant.userId,
      revoked
        ? 'That calendar connection was revoked and has to be reconnected.'
        : `That calendar could not be reached: ${message}`,
    )
  }

  const accessToken = tokens.accessToken()
  await saveGrant(system, {
    userId: grant.userId,
    provider: 'google',
    accessToken,
    // Google returns a refresh token on first consent and usually not on a
    // refresh. saveGrant keeps the stored one when this is null.
    refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt(),
  })
  return accessToken
}

// ---------------------------------------------------------------------------
// Free-busy
// ---------------------------------------------------------------------------

type CacheEntry = { at: number; busy: Interval[] }

/** Sixty seconds, per host and per window, per F2 §2. Bypassed at submit time,
 *  always, which is what the `bypassCache` argument is for and the only reason it
 *  exists. Bounded so a wide date range cannot grow it without limit. */
const CACHE_TTL_MS = 60_000
const MAX_CACHE_KEYS = 5_000
const cache = new Map<string, CacheEntry>()

const cacheKey = (ctx: AccountContext, userId: string, window: Window): string =>
  `${ctx.accountId}:${userId}:${window.from.toISOString()}:${window.to.toISOString()}`

const remember = (key: string, busy: Interval[]): void => {
  if (cache.size > MAX_CACHE_KEYS) {
    const now = Date.now()
    for (const [held, entry] of cache) {
      if (now - entry.at > CACHE_TTL_MS) cache.delete(held)
    }
    // Still over: drop oldest-inserted, which Map preserves.
    while (cache.size > MAX_CACHE_KEYS) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }
  cache.set(key, { at: Date.now(), busy })
}

export type Window = { from: Date; to: Date }

export type BusyResult = {
  /** Only hosts whose calendar was actually read. A host missing from this map is
   *  treated as unavailable downstream, which is the whole point. */
  busy: Map<string, Interval[]>
  /** One sentence per host that could not be read, for the admin health panel. */
  problems: string[]
}

export const busyForHosts = async (
  ctx: AccountContext,
  hosts: HostAvailability[],
  window: Window,
  { bypassCache = false } = {},
): Promise<BusyResult> => {
  const busy = new Map<string, Interval[]>()
  const problems: string[] = []

  // One request per host, because free-busy is read with that host's own
  // credential. Issued together rather than in sequence: five hosts should cost
  // one round trip's latency, not five.
  const results = await Promise.all(
    hosts.map(async (host) => {
      if (host.unavailableReason) return { host, busy: null, problem: null }
      try {
        return { host, busy: await busyForHost(ctx, host, window, bypassCache), problem: null }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        return { host, busy: null, problem: `${host.name}: ${message}` }
      }
    }),
  )

  for (const result of results) {
    if (result.busy) busy.set(result.host.userId, result.busy)
    if (result.problem) problems.push(result.problem)
  }
  return { busy, problems }
}

const busyForHost = async (
  ctx: AccountContext,
  host: HostAvailability,
  window: Window,
  bypassCache: boolean,
): Promise<Interval[]> => {
  if (host.provider === 'dev') {
    if (!devCalendarEnabled) {
      throw new CalendarUnavailable(
        host.userId,
        'This host is on the development calendar provider, which is refused outside development.',
      )
    }
    // Rawr's own confirmed bookings are counted by the engine already, so the
    // dev provider contributes nothing rather than pretending to know more.
    return []
  }

  if (!googleCalendarConfigured) {
    throw new CalendarUnavailable(
      host.userId,
      'Google Calendar is not configured on this deployment, so availability cannot be read.',
    )
  }

  const key = cacheKey(ctx, host.userId, window)
  if (!bypassCache) {
    const held = cache.get(key)
    if (held && Date.now() - held.at < CACHE_TTL_MS) return held.busy
  }

  const grant = await readGrant(ctx, host.userId)
  if (!grant || grant.state !== 'connected') {
    throw new CalendarUnavailable(host.userId, 'That calendar is not connected.')
  }

  const token = await accessTokenFor(ctx, grant)
  const response = await googleFetch(`${GOOGLE_API}/freeBusy`, token, {
    method: 'POST',
    body: JSON.stringify({
      timeMin: window.from.toISOString(),
      timeMax: window.to.toISOString(),
      items: [{ id: grant.calendarId }],
    }),
  })

  const payload = (await response.json()) as {
    calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }>
  }
  const calendar = payload.calendars?.[grant.calendarId]
  if (!calendar || calendar.errors?.length) {
    const reason = calendar?.errors?.[0]?.reason ?? 'no calendar in the response'
    throw new CalendarUnavailable(host.userId, `Google refused free-busy for that calendar: ${reason}.`)
  }

  const busy = (calendar.busy ?? []).map((slot) => ({
    start: new Date(slot.start),
    end: new Date(slot.end),
  }))
  remember(key, busy)
  return busy
}

const googleFetch = async (
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (response.ok) return response
  // Google's error body carries the reason a person needs; the status alone does
  // not distinguish "no such calendar" from "token revoked".
  const detail = await response.text().catch(() => '')
  throw new Error(
    `Google Calendar answered ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
  )
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventDraft = {
  userId: string
  summary: string
  description: string
  startsAt: Date
  endsAt: Date
  /** The host's zone, sent alongside the instant so Google shows the event in the
   *  timezone the host actually keeps. */
  timezone: string
  attendee: { name: string; email: string }
  /** Ask Google to create a Meet link. Only for location = google_meet; a Zoom
   *  page gets its link from Zoom and puts it in the description. */
  requestConference: boolean
  location: string | null
}

export type WrittenEvent = {
  eventId: string | null
  calendarId: string | null
  conferenceUrl: string | null
}

/** Writes the event on the host's own calendar. A failure here throws, and the
 *  caller runs inside the booking transaction, so nothing is written at all. F2 §4
 *  step 4: a CRM booking with no calendar event is worse than no booking. */
export const createCalendarEvent = async (
  ctx: AccountContext,
  draft: EventDraft,
): Promise<WrittenEvent> => {
  const grant = await readGrant(ctx, draft.userId)
  if (!grant || grant.state !== 'connected') {
    throw new Error(`${draft.userId} has no connected calendar, so the event cannot be created.`)
  }

  if (grant.provider === 'dev') {
    if (!devCalendarEnabled) throw new Error('The development calendar provider is refused here.')
    // Nothing is written anywhere, and the booking says so rather than implying a
    // calendar entry that does not exist.
    return { eventId: null, calendarId: grant.calendarId, conferenceUrl: null }
  }

  const token = await accessTokenFor(ctx, grant)
  const url = new URL(`${GOOGLE_API}/calendars/${encodeURIComponent(grant.calendarId)}/events`)
  // Required for Google to act on conferenceData at all; without it the create
  // request is accepted and the conference is silently dropped.
  if (draft.requestConference) url.searchParams.set('conferenceDataVersion', '1')
  url.searchParams.set('sendUpdates', 'all')

  const response = await googleFetch(url.toString(), token, {
    method: 'POST',
    body: JSON.stringify({
      summary: draft.summary,
      description: draft.description,
      start: { dateTime: draft.startsAt.toISOString(), timeZone: draft.timezone },
      end: { dateTime: draft.endsAt.toISOString(), timeZone: draft.timezone },
      attendees: [{ email: draft.attendee.email, displayName: draft.attendee.name }],
      ...(draft.location ? { location: draft.location } : {}),
      ...(draft.requestConference
        ? {
            conferenceData: {
              // Google requires this to be unique per creation attempt, and
              // reusing one returns the same conference, which is what a retry
              // of the same booking wants.
              createRequest: { requestId: `rawr-${draft.userId}-${draft.startsAt.getTime()}` },
            },
          }
        : {}),
    }),
  })

  const event = (await response.json()) as {
    id?: string
    hangoutLink?: string
    conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] }
  }
  const video = event.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === 'video',
  )?.uri

  return {
    eventId: event.id ?? null,
    calendarId: grant.calendarId,
    conferenceUrl: video ?? event.hangoutLink ?? null,
  }
}

export const patchCalendarEvent = async (
  ctx: AccountContext,
  input: {
    userId: string
    calendarId: string
    eventId: string
    startsAt?: Date
    endsAt?: Date
    timezone?: string
    description?: string
  },
): Promise<void> => {
  const grant = await readGrant(ctx, input.userId)
  if (!grant || grant.state !== 'connected') {
    throw new Error('That calendar is no longer connected, so the event could not be updated.')
  }
  if (grant.provider === 'dev') return

  const token = await accessTokenFor(ctx, grant)
  const url = new URL(
    `${GOOGLE_API}/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
  )
  url.searchParams.set('sendUpdates', 'all')

  await googleFetch(url.toString(), token, {
    method: 'PATCH',
    body: JSON.stringify({
      ...(input.startsAt && input.timezone
        ? { start: { dateTime: input.startsAt.toISOString(), timeZone: input.timezone } }
        : {}),
      ...(input.endsAt && input.timezone
        ? { end: { dateTime: input.endsAt.toISOString(), timeZone: input.timezone } }
        : {}),
      ...(input.description === undefined ? {} : { description: input.description }),
    }),
  })
}

/** Idempotent: a 404 or 410 means somebody already removed it, which is the state
 *  the caller wanted. Clicking cancel twice must not fail the second time. */
export const deleteCalendarEvent = async (
  ctx: AccountContext,
  input: { userId: string; calendarId: string; eventId: string },
): Promise<void> => {
  const grant = await readGrant(ctx, input.userId)
  if (!grant || grant.state !== 'connected') return
  if (grant.provider === 'dev') return

  const token = await accessTokenFor(ctx, grant)
  const url = new URL(
    `${GOOGLE_API}/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
  )
  url.searchParams.set('sendUpdates', 'all')

  const response = await fetch(url.toString(), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (response.ok || response.status === 404 || response.status === 410) return
  const detail = await response.text().catch(() => '')
  throw new Error(
    `Google Calendar refused to delete that event: ${response.status} ${detail.slice(0, 200)}`,
  )
}
