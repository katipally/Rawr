import type { HealthState } from '@rawr/db'

/** F6 §1's four states as the Connected apps screens badge them. */
export const HEALTH: Record<HealthState, { label: string; tone: 'ok' | 'warn' | 'error' | 'neutral' }> = {
  connected: { label: 'Connected', tone: 'ok' },
  degraded: { label: 'Needs attention', tone: 'warn' },
  disconnected: { label: 'Disconnected', tone: 'error' },
  not_configured: { label: 'Not connected', tone: 'neutral' },
}
