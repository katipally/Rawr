import type { HealthState } from '@rawr/db'

/** F6 §1's four states as the Connected apps screens badge them. */
export const HEALTH: Record<HealthState, { label: string; tone: 'ok' | 'warn' | 'error' | 'neutral' }> = {
  connected: { label: 'Connected', tone: 'ok' },
  degraded: { label: 'Needs attention', tone: 'warn' },
  disconnected: { label: 'Disconnected', tone: 'error' },
  not_configured: { label: 'Not connected', tone: 'neutral' },
}

/** A provider's stored last_error, split into the sentence a person reads and the
 *  body they only want while debugging. Gmail and Brevo both answer with a JSON
 *  document, and printing it verbatim buries the one line that says what happened. */
export const errorSummary = (raw: string): { headline: string; detail: string | null } => {
  const brace = raw.indexOf('{')
  if (brace < 0) return { headline: raw.trim(), detail: null }
  const lead = raw.slice(0, brace).replace(/[\s:]+$/, '')
  const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1]
  return { headline: message ? `${lead}: ${message}` : lead, detail: raw.trim() }
}
