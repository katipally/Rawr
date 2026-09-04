import {
  assertCanWrite,
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
import { enrichCompanyWithLusha, enrichContactWithLusha, testLusha } from './lusha.ts'
import { testSlack } from './slack.ts'
import { testWoodpecker } from './woodpecker.ts'
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
      'Person and company enrichment, and the events from sequences that are run in Apollo itself. Rawr runs its own sequences from a connected Gmail now, so nothing is enrolled through Apollo from here; what still comes back is enrichment, and the opens, clicks and replies of anything Apollo is sending, read onto the timeline.',
    failureMode:
      'Apollo down means the timeline is missing recent tracking events, and a degraded health state says so on the record rather than implying nobody opened anything.',
    secretLabel: 'API key',
    configFields: [],
    rows: ['Email Tracking', 'Company & Contact Enrichment'],
    setup: [
      'In Apollo, open Settings, then Integrations, then API. This needs API access on the plan, not only a seat (open item 7).',
      'Create a key with people and organisations scopes, and sequences too if Apollo is still sending anything of its own. Paste it below.',
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
    kind: 'lusha',
    name: 'Lusha',
    purpose:
      'The second enricher, between Apollo and Clay. Direct dials and work addresses, matched on an email address or a company domain.',
    failureMode:
      'A miss leaves the field blank and says so. Credits are spent only on fields that are still empty, so a run over records Apollo already answered costs nothing.',
    secretLabel: 'API key',
    configFields: [],
    rows: ['Company & Contact Enrichment'],
    setup: [
      'In Lusha, open the API Hub from the left sidebar.',
      'Copy the API key from the top right, or create one under Manage API Keys, and paste it below.',
      'The connection test reads the account\u2019s credit balance, which costs nothing.',
    ],
  },
  {
    kind: 'woodpecker',
    name: 'Woodpecker',
    purpose:
      'Volume sending, for runs a single Gmail account cannot carry. A Woodpecker sequence names a campaign; Rawr hands the prospect over once and Woodpecker owns the steps, the delays and the sending accounts.',
    failureMode:
      'A refused prospect is reported by name rather than forced through: Woodpecker rejects anybody who already replied, bounced or opted out, and that refusal is the protection working.',
    secretLabel: 'API key',
    configFields: [
      {
        key: 'campaignId',
        label: 'Default campaign',
        hint: 'The campaign a sequence enrolls into when it names none, by its Woodpecker id.',
      },
    ],
    rows: ['Email Sequences'],
    setup: [
      'In Woodpecker, open Marketplace, then Integrations, then API keys. This needs the API keys & integrations add-on.',
      'Create a key and paste it below.',
      'Paste the webhook URL below into Woodpecker under Webhooks, for sent, opened, clicked, replied, bounced and opted out.',
    ],
  },
  {
    kind: 'hubspot',
    name: 'HubSpot',
    purpose:
      'Reading the old portal one last time. Its exports are imported here, contacts and companies and deals, then the notes and logged emails onto the timelines they belong to.',
    failureMode:
      'Nothing to fail: this is a file import, not a live connection. A run that stops resumes from the row it reached, and importing the same export twice changes nothing.',
    secretLabel: null,
    configFields: [],
    rows: [],
    setup: [
      'In HubSpot, open the object list, then Export, and choose the columns you want with "Comma separated".',
      'Import each file here from Data management, Import, and pick the HubSpot importer.',
      'Nothing is pasted here: HubSpot is read from its own exports, so no key of theirs lives in Rawr.',
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
      { key: 'stageAlerts', label: 'Stage alerts', hint: 'Pipelines whose stage moves are announced, by name, comma-separated, e.g. Enterprise. Blank means none.' },
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
  if (kind === 'lusha') return testLusha(ctx)
  if (kind === 'woodpecker') return testWoodpecker(ctx)
  if (kind === 'hubspot') {
    return {
      ok: false,
      detail:
        'HubSpot is read from its own exports rather than over an API, so there is no connection to test. Start an import from Data management, Import.',
    }
  }
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

/** The fields an enricher is allowed to answer. Anything outside these two lists
 *  is either a human's decision or a relation, and neither belongs to a provider. */
const COMPANY_BLANKABLE = ['industry', 'employee_count', 'annual_revenue', 'city', 'country']
const CONTACT_BLANKABLE = ['first_name', 'last_name', 'title', 'linkedin_url', 'phone']

const blankIn = (keys: string[]) => (values: Record<string, unknown>): string[] =>
  keys.filter((key) => values[key] === null || values[key] === undefined || values[key] === '')

const stillBlank = blankIn(COMPANY_BLANKABLE)
const stillBlankOnContact = blankIn(CONTACT_BLANKABLE)

/** A company on its own: Apollo by domain, then Clay for what is still blank. */
export const enrichCompanyRecord = async (ctx: WorkspaceContext, companyId: string): Promise<EnrichmentRun> => {
  assertCanWrite(ctx, 'company')
  const company = await getRecord(ctx, 'company', companyId)
  if (!company) throw new Error('That company no longer exists.')
  const domain = typeof company.values.domain === 'string' ? company.values.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : ''
  if (!domain) {
    return { detail: 'That company has no domain, which is the only thing an enricher can match a company on.', written: [], suggested: [] }
  }

  const apollo = await enrichCompany(ctx, { companyId, domain })
  const run: EnrichmentRun = { detail: apollo.detail, written: [...apollo.written], suggested: [...apollo.suggested] }
  await fillWithLushaCompany(ctx, run, companyId, domain)
  const after = await getRecord(ctx, 'company', companyId)
  await fillWithClay(ctx, run, companyId, domain, stillBlank(after?.values ?? {}))
  return run
}

/** Every provider after the first is asked only about what is still empty, and
 *  each one's failure is its own: a Lusha outage must not stop Clay from
 *  answering, so the call is caught here rather than thrown out of the run. */
const absorb = async (
  run: EnrichmentRun,
  provider: string,
  call: () => Promise<{ detail: string; written: string[]; suggested: string[] }>,
): Promise<void> => {
  const outcome = await call().catch((cause: unknown) => ({
    detail: `${provider}: ${cause instanceof Error ? cause.message : String(cause)}`,
    written: [] as string[],
    suggested: [] as string[],
  }))
  run.detail = `${run.detail} ${outcome.detail}`
  run.written.push(...outcome.written)
  run.suggested.push(...outcome.suggested)
}

const fillWithLushaCompany = async (
  ctx: WorkspaceContext,
  run: EnrichmentRun,
  companyId: string,
  domain: string,
): Promise<void> => {
  const company = await getRecord(ctx, 'company', companyId)
  const missing = stillBlank(company?.values ?? {})
  if (missing.length === 0) return
  await absorb(run, 'Lusha', () => enrichCompanyWithLusha(ctx, { companyId, domain, missing }))
}

const fillWithClay = async (
  ctx: WorkspaceContext,
  run: EnrichmentRun,
  companyId: string,
  domain: string,
  missing: string[],
): Promise<void> => {
  if (missing.length === 0) return
  await absorb(run, 'Clay', () => enrichWithClay(ctx, { companyId, domain, missing }))
}

/** F6 §4's configured order, in one place: Apollo first for the person and the
 *  company, Clay second for whatever is still blank on the company. Neither
 *  overwrites a value a human entered; that rule lives in the enrichment layer and
 *  is not restated here. */
export const enrichRecord = async (
  ctx: WorkspaceContext,
  contactId: string,
): Promise<EnrichmentRun> => {
  assertCanWrite(ctx, 'contact')
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

  const afterApollo = await getRecord(ctx, 'contact', contactId)
  const companyBefore = companyId ? await getRecord(ctx, 'company', companyId) : null
  const missing = [
    ...stillBlankOnContact(afterApollo?.values ?? {}),
    ...(companyBefore ? stillBlank(companyBefore.values) : []),
  ]
  if (missing.length > 0) {
    await absorb(run, 'Lusha', () => enrichContactWithLusha(ctx, { contactId, email, companyId, missing }))
  }

  if (companyId) {
    const company = await getRecord(ctx, 'company', companyId)
    const domain = typeof company?.values.domain === 'string' ? company.values.domain : ''
    // Only what is still blank. Asking Clay to re-answer something Apollo or Lusha
    // answered is what "first non-empty by configured order wins" rules out.
    if (domain) await fillWithClay(ctx, run, companyId, domain, stillBlank(company?.values ?? {}))
  }

  return run
}
