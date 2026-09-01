import { readCredentials, recordHealth, type WorkspaceContext } from '@rawr/db'
import { devIntegrationsEnabled } from '~/lib/env.ts'
import { json, type ConnectionTest } from './provider.ts'

/** F6 §6. GA4 keeps doing aggregate reporting, which is what it is good at and
 *  what it already does sitewide via GTM-T79VHPL. D13 explains why the
 *  person-level half is built instead of delegated.
 *
 *  Two rules, and they are the whole file:
 *
 *  CONSENT   Forwarded only when analytics consent is granted. The collector has
 *            already refused to store anything without it, so an event reaching
 *            here at all implies consent; this checks again anyway, because the
 *            cost of the check is nothing and the cost of being wrong is a
 *            regulator.
 *
 *  NO PERSON No visitor id, no contact id, no email, nothing that could tie an
 *            event to a person. Sending personally identifiable information to
 *            GA4 violates its terms and Google may delete the property. */

const API = 'https://www.google-analytics.com/mp/collect'
const DEBUG_API = 'https://www.google-analytics.com/debug/mp/collect'

type Ga4Config = { measurementId?: string }

/** Anything that could name a person. Refused rather than stripped silently: a key
 *  arriving here means something upstream is wrong and somebody should know. */
const FORBIDDEN = new Set([
  'email',
  'e_mail',
  'user_email',
  'name',
  'first_name',
  'last_name',
  'phone',
  'contact_id',
  'visitor_id',
  'user_id',
  'address',
  'ip',
])

export const stripPersonal = (
  properties: Record<string, unknown>,
): { clean: Record<string, unknown>; refused: string[] } => {
  const clean: Record<string, unknown> = {}
  const refused: string[] = []
  for (const [key, value] of Object.entries(properties)) {
    if (FORBIDDEN.has(key.toLowerCase())) {
      refused.push(key)
      continue
    }
    clean[key] = value
  }
  return { clean, refused }
}

export const testGa4 = async (ctx: WorkspaceContext): Promise<ConnectionTest> => {
  try {
    const found = await readCredentials(ctx, 'ga4')
    const config = (found?.config ?? {}) as Ga4Config
    if (!config.measurementId || !found?.secret) {
      const detail = 'GA4 needs a measurement id and an API secret from the same data stream.'
      await recordHealth(ctx, 'ga4', { ok: false, error: detail })
      return { ok: false, detail }
    }
    if (devIntegrationsEnabled) {
      await recordHealth(ctx, 'ga4', { ok: true })
      return { ok: true, detail: 'Development provider. Nothing is sent to Google.' }
    }

    // The debug endpoint validates without recording, which is exactly what a
    // connection test wants: proof the credentials work with no test event
    // polluting the property.
    const result = await json<{ validationMessages?: { description?: string }[] }>({
      url: `${DEBUG_API}?measurement_id=${encodeURIComponent(config.measurementId)}&api_secret=${encodeURIComponent(found.secret)}`,
      method: 'POST',
      body: {
        client_id: 'rawr-connection-test',
        events: [{ name: 'rawr_connection_test', params: {} }],
      },
    })
    const problems = result.validationMessages ?? []
    if (problems.length > 0) {
      const detail = problems.map((message) => message.description).join('; ')
      await recordHealth(ctx, 'ga4', { ok: false, error: detail })
      return { ok: false, detail }
    }
    await recordHealth(ctx, 'ga4', { ok: true })
    return { ok: true, detail: 'Google validated the measurement id and secret.' }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await recordHealth(ctx, 'ga4', { ok: false, error: message })
    return { ok: false, detail: message }
  }
}

export type ForwardInput = {
  /** A per-event random id. Never the visitor id: that would let GA4's own
   *  reporting rejoin the events into a person, which is the thing D13 rules out. */
  clientId: string
  name: string
  properties: Record<string, unknown>
  analyticsConsent: boolean
}

export type ForwardOutcome = { sent: boolean; reason: string | null; refused: string[] }

/** Fire and forget, with a hard ceiling. F6's edge case is explicit: GA4
 *  forwarding that fails is dropped after retries and counted, never queued
 *  indefinitely. Aggregate analytics is not worth unbounded storage. */
export const forwardToGa4 = async (
  ctx: WorkspaceContext,
  input: ForwardInput,
): Promise<ForwardOutcome> => {
  if (!input.analyticsConsent) {
    return { sent: false, reason: 'Analytics consent was not granted, so nothing is forwarded.', refused: [] }
  }

  const found = await readCredentials(ctx, 'ga4')
  const config = (found?.config ?? {}) as Ga4Config
  if (!config.measurementId || !found?.secret) {
    return { sent: false, reason: 'GA4 is not configured.', refused: [] }
  }

  const { clean, refused } = stripPersonal(input.properties)
  if (devIntegrationsEnabled) {
    return { sent: true, reason: null, refused }
  }

  try {
    await json({
      url: `${API}?measurement_id=${encodeURIComponent(config.measurementId)}&api_secret=${encodeURIComponent(found.secret)}`,
      method: 'POST',
      body: { client_id: input.clientId, events: [{ name: input.name, params: clean }] },
      timeoutMs: 5_000,
    })
    return { sent: true, reason: null, refused }
  } catch (cause) {
    // Deliberately not dead-lettered. An aggregate hit that did not arrive is a
    // rounding error in a marketing report, and keeping a queue of them forever
    // would cost more than the data is worth.
    await recordHealth(ctx, 'ga4', {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    })
    return { sent: false, reason: 'Google did not accept the event. It is dropped, not queued.', refused }
  }
}
