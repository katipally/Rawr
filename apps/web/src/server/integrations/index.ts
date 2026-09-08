import {
  assertCanWrite,
  clearEnrichmentRequest,
  getRecord,
  listIntegrations,
  type IntegrationKind,
  type IntegrationRow,
  type AccountContext,
} from '@rawr/db'
import { devIntegrationsEnabled } from '~/lib/env.ts'
import { appPath, calendarsPath, mailboxesPath } from '~/lib/links.ts'
import { enrichCompany, enrichContact, testApollo } from './apollo.ts'
import { testBrevo } from './brevo.ts'
import { enrichWithClay, testClay } from './clay.ts'
import { testGa4 } from './ga4.ts'
import { enrichCompanyWithLusha, enrichContactWithLusha, testLusha } from './lusha.ts'
import { testSlack } from './slack.ts'
import { testTurnstile } from './turnstile.ts'
import { testWebflow } from './webflow.ts'
import { testWoodpecker } from './woodpecker.ts'
import { testZoom } from '../zoom.ts'
import type { ConnectionTest } from './provider.ts'

/** One registry of what an integration is, so the settings page, the health check
 *  and the connection test all read the same list rather than three hardcoded
 *  ones. F6 §1. */

/** Static: what an integration can touch is a fact about it, not a setting. */
export type PermissionGroup = { group: string; lines: string[] }

/** Not a database enum: adding a category means adding a provider. */
export type IntegrationCategory =
  | 'Enrichment'
  | 'Email'
  | 'Calendar'
  | 'Analytics'
  | 'Messaging'
  | 'Migration'
  | 'Security'
  | 'Website'

export type IntegrationMeta = {
  kind: IntegrationKind
  name: string
  category: IntegrationCategory
  /** Shared: one connection the whole account uses. Personal: granted per
   *  person, so the account-wide row is folded from everyone's grant. */
  appType: 'Shared' | 'Personal'
  permissions: PermissionGroup[]
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
    category: 'Email',
    appType: 'Shared',
    permissions: [
      {
        group: "Read your contacts",
        lines: [
          "View contacts in a segment and whether they may be mailed.",
          "View the subscription type a contact has opted out of.",
        ],
      },
      {
        group: "Send on your behalf",
        lines: [
          "Push a segment into a Brevo list and keep it upserted.",
          "Create and schedule a campaign against that list.",
        ],
      },
      {
        group: "Write back to the timeline",
        lines: [
          "Record deliveries, opens, clicks, bounces and unsubscribes as activity.",
        ],
      },
    ],
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
    category: 'Enrichment',
    appType: 'Shared',
    permissions: [
      {
        group: "Manage and view your CRM data",
        lines: [
          "View properties and other details about contacts.",
          "Create, delete, or make changes to contacts.",
          "View properties and other details about companies.",
          "Create, delete, or make changes to companies.",
        ],
      },
      {
        group: "Create timeline events",
        lines: [
          "Record opens, clicks and replies from anything Apollo is sending.",
        ],
      },
    ],
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
      'Create a master API key, or one with people/match, organizations/enrich, contacts, emailer_campaigns/search and emailer_messages/search. Paste it below.',
      'Sequence opens, clicks and replies are pulled by the Apollo sync rather than pushed: Apollo has no email-event webhook, so the webhook URL below only matters if something of yours posts to it.',
    ],
  },
  {
    kind: 'clay',
    category: 'Enrichment',
    appType: 'Shared',
    permissions: [
      {
        group: "Manage and view your CRM data",
        lines: [
          "View a company's domain.",
          "Create, delete, or make changes to companies.",
        ],
      },
    ],
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
    category: 'Enrichment',
    appType: 'Shared',
    permissions: [
      {
        group: "Manage and view your CRM data",
        lines: [
          "View a contact's email address and a company's domain.",
          "Create, delete, or make changes to contacts.",
          "Create, delete, or make changes to companies.",
        ],
      },
    ],
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
    category: 'Email',
    appType: 'Shared',
    permissions: [
      {
        group: "Read your contacts",
        lines: [
          "View the address, name and company of anybody being enrolled.",
        ],
      },
      {
        group: "Send on your behalf",
        lines: [
          "Hand a prospect to a campaign, which then owns the steps and the sending.",
        ],
      },
      {
        group: "Create timeline events",
        lines: [
          "Record sends, opens, clicks, replies, bounces and opt-outs as activity.",
        ],
      },
    ],
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
    category: 'Migration',
    appType: 'Shared',
    permissions: [
      {
        group: "Files",
        lines: [
          "Read an export you upload here. Nothing is sent to HubSpot and no key of theirs is stored.",
        ],
      },
    ],
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
    category: 'Messaging',
    appType: 'Shared',
    permissions: [
      {
        group: "Post messages",
        lines: [
          "Post a form fill to the channel a form names, or to the default one.",
          "Post a deal stage change for the pipelines you name.",
        ],
      },
      {
        group: "Read channels",
        lines: [
          "List channels, so a channel can be picked by name rather than by id.",
        ],
      },
    ],
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
      'Better: at api.slack.com/apps create an app, add the chat:write and channels:read bot scopes, install it to the account and paste the xoxb bot token instead (open item 4).',
      'Invite the bot to #sales-leads-2026, or whichever channel you name as the default.',
    ],
  },
  {
    kind: 'ga4',
    category: 'Analytics',
    appType: 'Shared',
    permissions: [
      {
        group: "Send aggregate events",
        lines: [
          "Forward an event name and its counts. Never a visitor id, a contact id or an address.",
        ],
      },
    ],
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
    category: 'Calendar',
    appType: 'Shared',
    permissions: [
      {
        group: "Create meetings",
        lines: [
          "Create a meeting and return its joining link when a booking is confirmed.",
        ],
      },
    ],
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
    category: 'Calendar',
    appType: 'Personal',
    permissions: [
      {
        group: "Read free-busy",
        lines: [
          "See when each host is busy, so a time is only offered when they are free.",
        ],
      },
      {
        group: "Write events",
        lines: [
          "Create, move and cancel the event a booking makes on that host's calendar.",
        ],
      },
    ],
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
  {
    kind: 'gmail',
    category: 'Email',
    appType: 'Personal',
    permissions: [
      {
        group: 'Read a mailbox',
        lines: [
          'Read the threads in each connected mailbox and file them on the contact, company or deal they are about.',
          'Anything internal, personal or on the exclusion list is refused before it is stored.',
        ],
      },
      {
        group: 'Send on your behalf',
        lines: [
          'Send sequence steps and one-off replies through a mailbox that granted sending, and nothing else.',
        ],
      },
    ],
    name: 'Gmail',
    purpose: 'Email history on every record, and the mailbox a sequence goes out through.',
    failureMode:
      'A mailbox that stops syncing keeps every thread it already brought in; only new mail waits. Sending through it fails loudly rather than silently, so a sequence step is retried, not lost.',
    secretLabel: null,
    configFields: [],
    rows: ['Email Tracking', 'Email Sequences'],
    setup: [
      'Nothing to paste here. Each person connects their own Gmail from Settings, Mailboxes.',
      'Reading is asked for first. Sending is a second consent, granted only by somebody who sends from Rawr.',
    ],
  },
  {
    kind: 'turnstile',
    category: 'Security',
    appType: 'Shared',
    permissions: [
      {
        group: 'Check a challenge',
        lines: [
          'Ask Cloudflare whether one widget answer is genuine, with the visitor\u2019s IP.',
          'Nothing about the submission itself is sent, and no answer is stored at Cloudflare.',
        ],
      },
    ],
    name: 'Cloudflare Turnstile',
    purpose: 'The challenge a form submission gets when its spam score lands in the middle band.',
    failureMode:
      'An unreachable Cloudflare quarantines the lead for review rather than losing it. With nothing connected, every mid-band submission is quarantined, which is the safe direction and a queue somebody has to work.',
    secretLabel: 'Secret key',
    configFields: [
      {
        key: 'siteKey',
        label: 'Site key',
        hint: 'Public by design: it is rendered into the visitor\u2019s browser. From the same widget as the secret.',
      },
    ],
    rows: ['Custom Lead Forms'],
    setup: [
      'At dash.cloudflare.com, Turnstile, Add widget. Name it Rawr and list every host your forms are embedded on.',
      'Copy the Site Key into the field below and the Secret Key into the secret.',
    ],
  },
  {
    kind: 'webflow',
    category: 'Website',
    appType: 'Shared',
    permissions: [
      {
        group: 'Verify a webhook',
        lines: [
          'Check that a native-form delivery was signed by your Webflow app before it becomes a lead.',
        ],
      },
    ],
    name: 'Webflow',
    purpose: 'Native Webflow forms reaching Rawr without the paid bridge, F3 \u00a77.',
    failureMode:
      'An unsigned or wrongly signed delivery is refused, because an unverified webhook is an open lead-injection endpoint. Replacing the native form with the Rawr embed is the better path: Webflow sends no query string, so attribution is weaker here.',
    secretLabel: 'Webhook signing secret',
    configFields: [],
    rows: ['Custom Lead Forms'],
    setup: [
      'At webflow.com/dashboard/account/apps build an app, then create the form_submission webhook through its Data API so deliveries are signed. A webhook made from the site dashboard carries no signature and is refused.',
      'Point it at /w/webflow?account=<account slug>&form=<form slug>. Paste the app\u2019s client secret below, or, for a webhook created with a site token, the secretKey Webflow returned when the webhook was made.',
    ],
  },
]

export const metaFor = (kind: IntegrationKind): IntegrationMeta => {
  const found = INTEGRATIONS.find((entry) => entry.kind === kind)
  if (!found) throw new Error(`"${kind}" is not an integration Rawr knows about.`)
  return found
}

/** Where somebody goes to connect it. A shared app is connected on its own
 *  settings tab; a personal one where each person grants their own. */
export const connectPathFor = (kind: IntegrationKind, accountSlug: string): string =>
  kind === 'gmail' ? mailboxesPath() : kind === 'google_calendar' ? calendarsPath(accountSlug) : appPath(kind, 'settings')

export type IntegrationView = IntegrationRow & { meta: IntegrationMeta }

export const readIntegrations = async (ctx: AccountContext): Promise<IntegrationView[]> => {
  const rows = await listIntegrations(ctx)
  return rows.map((row) => ({ ...row, meta: metaFor(row.kind) }))
}

/** The connection test F6 §1 requires of every integration without exception:
 *  the user runs it on save, it calls the provider, and it reports the real
 *  response rather than a generic success. */
export const testConnection = async (
  ctx: AccountContext,
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
  if (kind === 'zoom') return testZoom(ctx)
  if (kind === 'turnstile') return testTurnstile(ctx)
  if (kind === 'webflow') return testWebflow(ctx)
  return {
    ok: false,
    detail:
      `${metaFor(kind).name} is granted per person rather than once for the company, so there is no shared connection to test. Each person connects their own.`,
  }
}

export type EnrichmentRun = {
  detail: string
  written: string[]
  suggested: string[]
}

/** The fields an enricher is allowed to answer, and what the record page names
 *  as still blank. Anything outside these two lists is either a human's decision
 *  or a relation, and neither belongs to a provider. */
export const ENRICHABLE: Record<'contact' | 'company', string[]> = {
  company: ['industry', 'employee_count', 'annual_revenue', 'city', 'state', 'postal_code', 'country', 'phone', 'description', 'linkedin_url', 'founded_year', 'funding_raised'],
  contact: ['first_name', 'last_name', 'title', 'linkedin_url', 'phone', 'city', 'country', 'seniority', 'department'],
}

const blankIn = (keys: string[]) => (values: Record<string, unknown>): string[] =>
  keys.filter((key) => values[key] === null || values[key] === undefined || values[key] === '')

const stillBlank = blankIn(ENRICHABLE.company)
const stillBlankOnContact = blankIn(ENRICHABLE.contact)

export const ENRICHERS = ['apollo', 'lusha', 'clay'] as const
export type Enricher = (typeof ENRICHERS)[number]

/** Which enrichers this account can actually call. A provider with no key,
 *  or one whose key was rejected, is left out of the run rather than asked and
 *  reported as a failure on every record. */
export const connectedEnrichers = async (ctx: AccountContext): Promise<Set<Enricher>> => {
  const rows = await listIntegrations(ctx)
  return new Set(
    ENRICHERS.filter((kind) => {
      const row = rows.find((entry) => entry.kind === kind)
      if (!row) return false
      // The development providers answer from fixtures and hold no key, so the
      // key is what says a provider is callable everywhere else.
      if (!row.hasSecret && !devIntegrationsEnabled) return false
      return row.state === 'connected' || row.state === 'degraded'
    }),
  )
}

/** Every provider is asked only about what is still empty, and each one's
 *  failure is its own: a Lusha outage must not stop Clay from answering, so the
 *  call is caught here rather than thrown out of the run. */
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
  run.detail = `${run.detail} ${outcome.detail}`.trim()
  run.written.push(...outcome.written)
  run.suggested.push(...outcome.suggested)
}

const NONE: EnrichmentRun = {
  detail: 'No enricher is connected. Add Apollo, Lusha or Clay in Settings, under Integrations.',
  written: [],
  suggested: [],
}

/** A company on its own: Apollo by domain, then Lusha, then Clay, each for what
 *  is still blank. F6 §4's configured order, in one place. */
export const enrichCompanyRecord = async (ctx: AccountContext, companyId: string): Promise<EnrichmentRun> => {
  assertCanWrite(ctx, 'company')
  const company = await getRecord(ctx, 'company', companyId)
  // Deleted between the dispatch that claimed it and this run. There is nothing
  // to enrich and nothing to retry, so take it off the queue and say so.
  if (!company) {
    await clearEnrichmentRequest(ctx, 'company', companyId)
    return { detail: 'That company was deleted before it could be enriched.', written: [], suggested: [] }
  }
  const domain = typeof company.values.domain === 'string' ? company.values.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : ''
  if (!domain) {
    return { detail: 'That company has no domain, which is the only thing an enricher can match a company on.', written: [], suggested: [] }
  }
  const connected = await connectedEnrichers(ctx)
  if (connected.size === 0) return NONE

  // Off the queue however it ran: this call is the consent for this record.
  await clearEnrichmentRequest(ctx, 'company', companyId)

  const run: EnrichmentRun = { detail: '', written: [], suggested: [] }
  if (connected.has('apollo')) await absorb(run, 'Apollo', () => enrichCompany(ctx, { companyId, domain }))
  if (connected.has('lusha')) {
    const missing = stillBlank((await getRecord(ctx, 'company', companyId))?.values ?? {})
    if (missing.length > 0) await absorb(run, 'Lusha', () => enrichCompanyWithLusha(ctx, { companyId, domain, missing }))
  }
  if (connected.has('clay')) {
    const missing = stillBlank((await getRecord(ctx, 'company', companyId))?.values ?? {})
    if (missing.length > 0) await absorb(run, 'Clay', () => enrichWithClay(ctx, { companyId, domain, missing }))
  }
  return run
}

/** A person, and their company where one is linked. Neither overwrites a value
 *  a human entered; that rule lives in the enrichment layer and is not restated
 *  here. */
export const enrichRecord = async (
  ctx: AccountContext,
  contactId: string,
): Promise<EnrichmentRun> => {
  assertCanWrite(ctx, 'contact')
  const record = await getRecord(ctx, 'contact', contactId)
  if (!record) {
    await clearEnrichmentRequest(ctx, 'contact', contactId)
    return { detail: 'That contact was deleted before it could be enriched.', written: [], suggested: [] }
  }

  const email = typeof record.values.email === 'string' ? record.values.email : ''
  if (!email) {
    return {
      detail: 'That contact has no email address, which is the only thing an enricher can match a person on.',
      written: [],
      suggested: [],
    }
  }
  const connected = await connectedEnrichers(ctx)
  if (connected.size === 0) return NONE
  const companyId = typeof record.values.company_id === 'string' ? record.values.company_id : null

  await clearEnrichmentRequest(ctx, 'contact', contactId)

  const run: EnrichmentRun = { detail: '', written: [], suggested: [] }
  if (connected.has('apollo')) await absorb(run, 'Apollo', () => enrichContact(ctx, { contactId, email, companyId }))

  if (connected.has('lusha')) {
    const [contact, company] = await Promise.all([
      getRecord(ctx, 'contact', contactId),
      companyId ? getRecord(ctx, 'company', companyId) : Promise.resolve(null),
    ])
    const missing = [...stillBlankOnContact(contact?.values ?? {}), ...(company ? stillBlank(company.values) : [])]
    if (missing.length > 0) await absorb(run, 'Lusha', () => enrichContactWithLusha(ctx, { contactId, email, companyId, missing }))
  }

  if (connected.has('clay') && companyId) {
    const company = await getRecord(ctx, 'company', companyId)
    const domain = typeof company?.values.domain === 'string' ? company.values.domain : ''
    const missing = stillBlank(company?.values ?? {})
    if (domain && missing.length > 0) await absorb(run, 'Clay', () => enrichWithClay(ctx, { companyId, domain, missing }))
  }

  return run
}
