import { env, zoomConfigured } from '~/lib/env.ts'

/** F2 §4 step 5. The conference link, when a page's location is Zoom.
 *
 *  A server-to-server OAuth app: one credential for the whole account, no per-user
 *  consent, which is what open item 5 asks for. The meeting is created under the
 *  assigned host's own Zoom user so it lands in their meeting list and they can
 *  start it.
 *
 *  Nothing here throws into the booking path. Zoom being down must not lose a
 *  booking, so a failure comes back as a reason and the caller confirms the meeting
 *  without a link. */

const TOKEN_URL = 'https://zoom.us/oauth/token'
const API = 'https://api.zoom.us/v2'
const TIMEOUT_MS = 8_000

type CachedToken = { token: string; expiresAt: number }
let cached: CachedToken | null = null

/** Zoom's account_credentials token lives an hour. Renewed a minute early so a
 *  booking never races the expiry. */
const accessToken = async (): Promise<string> => {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token

  const credentials = Buffer.from(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`).toString(
    'base64',
  )
  const response = await fetch(
    `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(env.ZOOM_ACCOUNT_ID)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${credentials}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  )

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Zoom refused the credential: ${response.status} ${detail.slice(0, 200)}`)
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number }
  if (!payload.access_token) throw new Error('Zoom returned no access token.')
  cached = {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  }
  return cached.token
}

export type ZoomMeeting = { joinUrl: string; meetingId: string }

export type ZoomRequest = {
  /** The host's address. Zoom accepts an email in place of a user id, which saves
   *  storing a second identifier for every person. */
  hostEmail: string
  topic: string
  agenda: string
  startsAt: Date
  durationMinutes: number
  timezone: string
}

export type ZoomOutcome =
  | { ok: true; meeting: ZoomMeeting }
  | { ok: false; reason: string }

export const createZoomMeeting = async (request: ZoomRequest): Promise<ZoomOutcome> => {
  if (!zoomConfigured) {
    return {
      ok: false,
      reason:
        'Zoom is not configured on this deployment (open item 5), so this meeting has no Zoom link.',
    }
  }

  try {
    const token = await accessToken()
    const response = await fetch(
      `${API}/users/${encodeURIComponent(request.hostEmail)}/meetings`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: request.topic.slice(0, 200),
          // 2 is a scheduled meeting. Zoom's other types are recurring and instant,
          // neither of which a booking is.
          type: 2,
          start_time: request.startsAt.toISOString(),
          duration: request.durationMinutes,
          timezone: request.timezone,
          agenda: request.agenda.slice(0, 2000),
          settings: {
            // The attendee is external and the host may be a minute late. A waiting
            // room on a sales call is a way to lose the call.
            join_before_host: true,
            waiting_room: false,
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    )

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return {
        ok: false,
        reason: `Zoom answered ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      }
    }

    const meeting = (await response.json()) as { id?: number | string; join_url?: string }
    if (!meeting.join_url) return { ok: false, reason: 'Zoom created a meeting with no join link.' }
    return {
      ok: true,
      meeting: { joinUrl: meeting.join_url, meetingId: String(meeting.id ?? '') },
    }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** Idempotent, like the calendar delete: a meeting Zoom has already forgotten is
 *  the state the caller wanted. Never throws, because it runs while a cancellation
 *  is being confirmed and the cancellation is what matters. */
export const deleteZoomMeeting = async (meetingId: string): Promise<void> => {
  if (!zoomConfigured || !meetingId) return
  try {
    const token = await accessToken()
    await fetch(`${API}/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // A Zoom meeting nobody joins costs nothing. Failing the cancellation over it
    // would cost the person their afternoon.
  }
}

export const updateZoomMeeting = async (
  meetingId: string,
  input: { startsAt: Date; durationMinutes: number; timezone: string },
): Promise<ZoomOutcome> => {
  if (!zoomConfigured || !meetingId) {
    return { ok: false, reason: 'Zoom is not configured, so the meeting time was not moved there.' }
  }
  try {
    const token = await accessToken()
    const response = await fetch(`${API}/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        start_time: input.startsAt.toISOString(),
        duration: input.durationMinutes,
        timezone: input.timezone,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { ok: false, reason: `Zoom refused the change: ${response.status} ${detail.slice(0, 200)}` }
    }
    // A PATCH returns no body, and the join link does not change when the time does.
    return { ok: true, meeting: { joinUrl: '', meetingId } }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }
}
