import {
  getRecord,
  listIntegrations,
  type IntegrationKind,
  type IntegrationRow,
  type WorkspaceContext,
} from '@rawr/db'
import { enrichCompany, enrichContact, testApollo } from './apollo.ts'
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
  /** Where the credential comes from, as steps a person follows in the provider's
   *  own UI. Written once here so the settings form can show them beside the field. */
  setup: string[]
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
      {
        key: 'subscriptionType',
        label: 'Subscription type',
        hint: 'The Rawr subscription type a Brevo unsubscribe applies to, by name, e.g. Newsletter. Blank means every type that is not internal, sales one-to-ones included.',
      },
    ],
    rows: ['Newsletter'],
    setup: [
      'In Brevo, open your profile menu, then SMTP & API, then the API Keys tab.',
      'Generate a new v3 key named "Rawr" and paste it below. Brevo shows it once.',
      'Under Contacts, Lists, open the list newsletters go to and copy the number from its URL.',
      'Paste the webhook URL below into Brevo under Transactional, Settings, Webhooks, for delivered, opened, clicked, hard bounce and unsubscribed.',
    ],
  },
  {
    kind: 'apollo',
    name: 'Apollo',
    purpose:
      'Sequences, email tracking, and person and company enrichment. A contact is enrolled in a sequence from its record; Rawr sends no sequence email and builds no pixel. Steps, replies, opens and clicks are Apollo’s own events, read back onto the timeline.',
    failureMode:
      'Apollo down means the timeline is missing recent tracking events, and a degraded health state says so on the record rather than implying nobody opened anything.',
    secretLabel: 'API key',
    configFields: [],
    rows: ['Email Sequences', 'Email Tracking', 'Company & Contact Enrichment'],
    setup: [
      'In Apollo, open Settings, then Integrations, then API. This needs API access on the plan, not only a seat (open item 7).',
      'Create a key with people, organisations and sequences scopes and paste it below.',
      'Paste the webhook URL below into Apollo under Settings, Integrations, Webhooks so opens, clicks and replies flow back.',
    ],
  },
  {
    kind: 'clay',
    name: 'Clay',
    purpose: 'The second enricher: a company’s domain is pushed into a Clay table, and whatever Apollo left blank comes back by webhook.',
    failureMode:
      'On the Launch tier there is no webhook or HTTP API sync at all, so this degrades to a documented CSV round trip and says so, rather than silently doing nothing.',
    secretLabel: 'Webhook auth token',
    configFields: [
      { key: 'webhookUrl', label: 'Table webhook URL', hint: 'The Clay table Rawr pushes domains into.' },
      { key: 'tier', label: 'Plan tier', hint: 'launch or growth. Launch has no API write-back.' },
    ],
    rows: ['Company & Contact Enrichment'],
    setup: [
      'In Clay, open the enrichment table and add a Webhook source; copy its URL into "Table webhook URL".',
      'Add an HTTP API column at the end of the table that posts each row to the webhook URL below, with the token as a bearer header.',
      'Make up a long random token, paste it below and into that column\u2019s Authorization header. Rawr refuses anything else.',
      'Set the tier to what the Clay account is on. Launch has no HTTP API, so enrichment degrades to CSV (open item 12).',
    ],
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
    setup: [
      'Quickest: in Slack open the channel, then its settings, Integrations, Add an app, Incoming WebHooks; copy the webhook URL and paste it as the secret.',
      'Better: at api.slack.com/apps create an app, add the chat:write and channels:read bot scopes, install it to the workspace and paste the xoxb bot token instead (open item 4).',
      'Invite the bot to #sales-leads-2026, or whichever channel you name as the default.',
    ],
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
    setup: [
      'In Google Analytics, Admin, Data streams, open the datasaur.ai web stream and copy its Measurement ID.',
      'On the same screen, Measurement Protocol API secrets, create one named "Rawr" and paste it below.',
    ],
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
    setup: [
      'At marketplace.zoom.us, Develop, Build App, choose Server-to-Server OAuth (open item 5).',
      'Add the meeting:write:admin scope, activate the app, and copy the Account ID, Client ID and Client Secret from the App Credentials tab.',
    ],
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
    setup: [
      'Nothing to paste here. Each host connects their own calendar from Your account, or Meetings, Calendars.',
      'The Google project behind it is open item 3; until then the development calendar stands in.',
    ],
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
  detail: string
  written: string[]
  suggested: string[]
}

const BLANKABLE = ['industry', 'employee_count', 'annual_revenue', 'city', 'country']

const stillBlank = (values: Record<string, unknown>): string[] =>
  BLANKABLE.filter((key) => values[key] === null || values[key] === undefined || values[key] === '')

/** A company on its own: Apollo by domain, then Clay for what is still blank. */
export const enrichCompanyRecord = async (ctx: WorkspaceContext, companyId: string): Promise<EnrichmentRun> => {
  const company = await getRecord(ctx, 'company', companyId)
  if (!company) throw new Error('That company no longer exists.')
  const domain = typeof company.values.domain === 'string' ? company.values.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : ''
  if (!domain) {
    return { detail: 'That company has no domain, which is the only thing an enricher can match a company on.', written: [], suggested: [] }
  }

  const apollo = await enrichCompany(ctx, { companyId, domain })
  const run: EnrichmentRun = { detail: apollo.detail, written: [...apollo.written], suggested: [...apollo.suggested] }
  const after = await getRecord(ctx, 'company', companyId)
  await fillWithClay(ctx, run, companyId, domain, stillBlank(after?.values ?? {}))
  return run
}

const fillWithClay = async (
  ctx: WorkspaceContext,
  run: EnrichmentRun,
  companyId: string,
  domain: string,
  missing: string[],
): Promise<void> => {
  if (missing.length === 0) return
  const clay = await enrichWithClay(ctx, { companyId, domain, missing }).catch((cause: unknown) => ({
    provider: 'clay' as const,
    matched: false,
    written: [] as string[],
    suggested: [] as string[],
    detail: cause instanceof Error ? cause.message : String(cause),
  }))
  run.detail = `${run.detail} ${clay.detail}`
  run.written.push(...clay.written)
  run.suggested.push(...clay.suggested)
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
      detail: 'That contact has no email address, which is the only thing an enricher can match a person on.',
      written: [],
      suggested: [],
    }
  }
  const companyId = typeof record.values.company_id === 'string' ? record.values.company_id : null

  const apollo = await enrichContact(ctx, { contactId, email, companyId })
  const run: EnrichmentRun = { detail: apollo.detail, written: [...apollo.written], suggested: [...apollo.suggested] }

  if (companyId) {
    const company = await getRecord(ctx, 'company', companyId)
    const domain = typeof company?.values.domain === 'string' ? company.values.domain : ''
    // Only what is still blank. Asking Clay to re-answer something Apollo answered
    // is what "first non-empty by configured order wins" rules out.
    if (domain) await fillWithClay(ctx, run, companyId, domain, stillBlank(company?.values ?? {}))
  }

  return run
}
