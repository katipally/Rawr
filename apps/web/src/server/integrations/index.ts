import {
  getRecord,
  listIntegrations,
  type IntegrationKind,
  type IntegrationRow,
  type WorkspaceContext,
} from '@rawr/db'
import { enrichContact, testApollo } from './apollo.ts'
import { testBrevo } from './brevo.ts'
import { enrichWithClay, testClay } from './clay.ts'
import { testGa4 } from './ga4.ts'
import { testSlack } from './slack.ts'
import type { ConnectionTest } from './provider.ts'

/** One registry of what an integration is, so the settings page, the health check
 *  and the connection test all read the same list rather than three hardcoded
 *  ones. F6 §1. */

export type IntegrationMeta = {
  kind: IntegrationKind
  name: string
  /** What it does, in the words of the row it satisfies. */
  purpose: string
  /** What breaks when it is down, from each provider's failure-mode paragraph. */
  failureMode: string
  /** Named so the settings form can label the field a person has to paste in. */
  secretLabel: string | null
  configFields: { key: string; label: string; hint: string }[]
  /** Which Notion rows this is the answer to. */
  rows: string[]
}

export const INTEGRATIONS: IntegrationMeta[] = [
  {
    kind: 'brevo',
    name: 'Brevo',
    purpose: 'The newsletter. Rawr owns the audience and the opt-out; Brevo owns the editor and the send.',
    failureMode:
      'Brevo down means list pushes queue and dead-letter, and the stats sync resumes from its cursor. No duplicate contacts, because the upsert is keyed on email.',
    secretLabel: 'API key (v3)',
    configFields: [
      { key: 'listId', label: 'List id', hint: 'The Brevo list a segment push writes into.' },
    ],
    rows: ['Newsletter'],
  },
  {
    kind: 'apollo',
    name: 'Apollo',
    purpose:
      'Sequences, email tracking and person enrichment. Rawr sends no sequence email and builds no pixel; these are Apollo’s own events read back onto the timeline.',
    failureMode:
      'Apollo down means the timeline is missing recent tracking events, and a degraded health state says so on the record rather than implying nobody opened anything.',
    secretLabel: 'API key',
    configFields: [],
    rows: ['Email Sequences', 'Email Tracking', 'Company & Contact Enrichment'],
  },
  {
    kind: 'clay',
    name: 'Clay',
    purpose: 'The second enricher, filling what Apollo left blank on a company.',
    failureMode:
      'On the Launch tier there is no webhook or HTTP API sync at all, so this degrades to a documented CSV round trip and says so, rather than silently doing nothing.',
    secretLabel: 'Webhook auth token',
    configFields: [
      { key: 'webhookUrl', label: 'Table webhook URL', hint: 'The Clay table Rawr pushes domains into.' },
      { key: 'tier', label: 'Plan tier', hint: 'launch or growth. Launch has no API write-back.' },
    ],
    rows: ['Company & Contact Enrichment'],
  },
  {
    kind: 'slack',
    name: 'Slack',
    purpose: 'Form-fill notifications to #sales-leads-2026, and deal stage-change alerts.',
    failureMode: 'Dead-letter, red health, and leads keep saving. A Slack outage never loses a lead.',
    secretLabel: 'Bot token, or an incoming webhook URL',
    configFields: [
      { key: 'channel', label: 'Default channel', hint: 'Where a form fill lands when a form names none.' },
      { key: 'stageAlerts', label: 'Stage alerts', hint: 'Comma-separated pipeline ids to announce moves for.' },
    ],
    rows: ['Custom Lead Forms'],
  },
  {
    kind: 'ga4',
    name: 'Google Analytics 4',
    purpose:
      'Aggregate reporting only. Never a visitor id, a contact id or an address: sending those would violate its terms.',
    failureMode: 'A forwarded event that fails is dropped after retries and counted, never queued indefinitely.',
    secretLabel: 'Measurement Protocol API secret',
    configFields: [
      { key: 'measurementId', label: 'Measurement id', hint: 'G-XXXXXXX, from the same data stream as the secret.' },
    ],
    rows: [],
  },
  {
    kind: 'zoom',
    name: 'Zoom',
    purpose: 'The joining link on a booked meeting.',
    failureMode:
      'A booking still confirms without a link, the host is told, and a job retries. Losing a booking over a Zoom outage is the wrong trade.',
    secretLabel: 'Server-to-server OAuth client secret',
    configFields: [
      { key: 'accountId', label: 'Account id', hint: 'From the server-to-server OAuth app.' },
      { key: 'clientId', label: 'Client id', hint: 'From the same app.' },
    ],
    rows: ['Book Meeting'],
  },
  {
    kind: 'google_calendar',
    name: 'Google Calendar',
    purpose: 'Free-busy for every host, and the event a booking creates.',
    failureMode:
      'A host with no grant is treated as unavailable, never as free, because failing open would double-book a real person. Grants are per user and live on the Meetings screen.',
    secretLabel: null,
    configFields: [],
    rows: ['Book Meeting', 'Calendar Links'],
  },
]

export const metaFor = (kind: IntegrationKind): IntegrationMeta => {
  const found = INTEGRATIONS.find((entry) => entry.kind === kind)
  if (!found) throw new Error(`"${kind}" is not an integration Rawr knows about.`)
  return found
}

export type IntegrationView = IntegrationRow & { meta: IntegrationMeta }

export const readIntegrations = async (ctx: WorkspaceContext): Promise<IntegrationView[]> => {
  const rows = await listIntegrations(ctx)
  return rows.map((row) => ({ ...row, meta: metaFor(row.kind) }))
}

/** The connection test F6 §1 requires of every integration without exception:
 *  the user runs it on save, it calls the provider, and it reports the real
 *  response rather than a generic success. */
export const testConnection = async (
  ctx: WorkspaceContext,
  kind: IntegrationKind,
): Promise<ConnectionTest> => {
  if (kind === 'brevo') return testBrevo(ctx)
  if (kind === 'apollo') return testApollo(ctx)
  if (kind === 'clay') return testClay(ctx)
  if (kind === 'ga4') return testGa4(ctx)
  if (kind === 'slack') return testSlack(ctx)
  if (kind === 'zoom') {
    return {
      ok: false,
      detail:
        'Zoom is configured from the environment on this deployment, and its health shows on a booking that needed a link. Open item 5.',
    }
  }
  return {
    ok: false,
    detail:
      'Google Calendar is granted per person rather than per workspace. Connect yours from Meetings, under Calendars.',
  }
}

export type EnrichmentRun = {
  contactId: string
  detail: string
  written: string[]
  suggested: string[]
}

/** F6 §4's configured order, in one place: Apollo first for the person and the
 *  company, Clay second for whatever is still blank on the company. Neither
 *  overwrites a value a human entered; that rule lives in the enrichment layer and
 *  is not restated here. */
export const enrichRecord = async (
  ctx: WorkspaceContext,
  contactId: string,
): Promise<EnrichmentRun> => {
  const record = await getRecord(ctx, 'contact', contactId)
  if (!record) throw new Error('That contact no longer exists.')

  const email = typeof record.values.email === 'string' ? record.values.email : ''
  if (!email) {
    return {
      contactId,
      detail: 'That contact has no email address, which is the only thing an enricher can match on.',
      written: [],
      suggested: [],
    }
  }
  const companyId = typeof record.values.company_id === 'string' ? record.values.company_id : null

  const apollo = await enrichContact(ctx, { contactId, email, companyId })
  const details = [apollo.detail]
  const written = [...apollo.written]
  const suggested = [...apollo.suggested]

  if (companyId) {
    const company = await getRecord(ctx, 'company', companyId)
    const domain = typeof company?.values.domain === 'string' ? company.values.domain : ''
    // Only what is still blank. Asking Clay to re-answer something Apollo answered
    // is what "first non-empty by configured order wins" rules out.
    const missing = ['industry', 'employee_count', 'annual_revenue', 'city', 'country'].filter((key) => {
      const value = company?.values[key]
      return value === null || value === undefined || value === ''
    })

    if (domain && missing.length > 0) {
      const clay = await enrichWithClay(ctx, { companyId, domain, missing }).catch((cause: unknown) => ({
        provider: 'clay' as const,
        matched: false,
        written: [] as string[],
        suggested: [] as string[],
        detail: cause instanceof Error ? cause.message : String(cause),
      }))
      details.push(clay.detail)
      written.push(...clay.written)
      suggested.push(...clay.suggested)
    }
  }

  return { contactId, detail: details.join(' '), written, suggested }
}
