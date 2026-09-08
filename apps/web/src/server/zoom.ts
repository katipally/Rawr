import { readCredentials, recordHealth, type AccountContext } from '@rawr/db'
import type { ConnectionTest } from './integrations/provider.ts'

/** Nothing here throws: a Zoom outage must not lose a booking, so failure comes
 *  back as a reason and the caller confirms without a link. */

const TOKEN_URL = 'https://zoom.us/oauth/token'
const API = 'https://api.zoom.us/v2'
const TIMEOUT_MS = 8_000

type ZoomCredentials = { accountId: string; clientId: string; clientSecret: string }

const credentials = async (ctx: AccountContext): Promise<ZoomCredentials | null> => {
  const stored = await readCredentials(ctx, 'zoom')
  if (!stored?.secret) return null
  const config = stored.config as { accountId?: unknown; clientId?: unknown }
  const accountId = typeof config.accountId === 'string' ? config.accountId.trim() : ''
  const clientId = typeof config.clientId === 'string' ? config.clientId.trim() : ''
  if (!accountId || !clientId) return null
  return { accountId, clientId, clientSecret: stored.secret }
}

export const zoomReady = async (ctx: AccountContext): Promise<boolean> =>
  (await credentials(ctx)) !== null

type CachedToken = { token: string; expiresAt: number }

/** Keyed by account: a shared slot would hand one organisation another's token. */
const cached = new Map<string, CachedToken>()

/** Renewed a minute before the hour so a booking never races the expiry. */
const accessToken = async (creds: ZoomCredentials): Promise<string> => {
  const hit = cached.get(creds.accountId)
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token

  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')
  const response = await fetch(
    `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(creds.accountId)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
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
  cached.set(creds.accountId, {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  })
  return payload.access_token
}

export type ZoomMeeting = { joinUrl: string; meetingId: string }

export type ZoomRequest = {
  /** Zoom takes an email in place of a user id, so we store no second identifier. */
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

export const createZoomMeeting = async (
  ctx: AccountContext,
  request: ZoomRequest,
): Promise<ZoomOutcome> => {
  const creds = await credentials(ctx)
  if (!creds) {
    return {
      ok: false,
      reason:
        'Zoom is not connected. Paste the server-to-server OAuth credentials on Settings, Integrations.',
    }
  }

  try {
    const token = await accessToken(creds)
    const response = await fetch(
      `${API}/users/${encodeURIComponent(request.hostEmail)}/meetings`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: request.topic.slice(0, 200),
          // 2 is a scheduled meeting; the other types are recurring and instant.
          type: 2,
          start_time: request.startsAt.toISOString(),
          duration: request.durationMinutes,
          timezone: request.timezone,
          agenda: request.agenda.slice(0, 2000),
          settings: {
            // A waiting room on a sales call is a way to lose the call.
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

/** Never throws: it runs while a cancellation is being confirmed. */
export const deleteZoomMeeting = async (
  ctx: AccountContext,
  meetingId: string,
): Promise<void> => {
  if (!meetingId) return
  try {
    const creds = await credentials(ctx)
    if (!creds) return
    const token = await accessToken(creds)
    await fetch(`${API}/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // An orphaned Zoom meeting costs nothing; a refused cancellation costs a day.
  }
}

export const updateZoomMeeting = async (
  ctx: AccountContext,
  meetingId: string,
  input: { startsAt: Date; durationMinutes: number; timezone: string },
): Promise<ZoomOutcome> => {
  if (!meetingId) {
    return { ok: false, reason: 'That meeting has no Zoom meeting to move.' }
  }
  try {
    const creds = await credentials(ctx)
    if (!creds) {
      return { ok: false, reason: 'Zoom is not connected, so the meeting time was not moved there.' }
    }
    const token = await accessToken(creds)
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
    // A PATCH returns no body, and the join link outlives a time change.
    return { ok: true, meeting: { joinUrl: '', meetingId } }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** Minting a token is the call every later request depends on. */
export const testZoom = async (ctx: AccountContext): Promise<ConnectionTest> => {
  const creds = await credentials(ctx)
  if (!creds) {
    const detail = 'Paste the Account id, Client id and client secret from the server-to-server OAuth app.'
    await recordHealth(ctx, 'zoom', { ok: false, error: detail })
    return { ok: false, detail }
  }
  try {
    await accessToken(creds)
    await recordHealth(ctx, 'zoom', { ok: true })
    return { ok: true, detail: `Zoom issued a token for account ${creds.accountId}.` }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    // Zoom answers a bad credential with 400, not 401, so the message decides.
    await recordHealth(ctx, 'zoom', { ok: false, error: detail, disconnected: /refused the credential/.test(detail) })
    return { ok: false, detail }
  }
}
