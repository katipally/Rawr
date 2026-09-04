import {
  applyEnrichment,
  contactsLinkedTo,
  externalIdOf,
  assertCanWrite,
  getRecord,
  ingestMarketingEvent,
  once,
  readCredentials,
  recordHealth,
  setExternalId,
  type MarketingEvent,
  type WorkspaceContext,
} from '@rawr/db'
import { devIntegrationsEnabled } from '~/lib/env.ts'
import { attempt, json, type ConnectionTest } from './provider.ts'

/** F6 §3 and §4. Two Notion rows and half of a third, one provider.
 *
 *  SEQUENCES      Rawr does not send sequence email. It reads back where a
 *                 sequence got to and puts that on the timeline, and links out to
 *                 Apollo for the rest.
 *  EMAIL TRACKING The row Ivan asked for: "understanding who has opened an email I
 *                 send." Rawr builds no pixel and no link redirector (D7); these
 *                 are Apollo's own events, read back.
 *  ENRICHMENT     Person and company. Apollo first, Clay second for what is
 *                 missing, and neither overwrites a human. */

const API = 'https://api.apollo.io/api/v1'

const credentials = async (ctx: WorkspaceContext) => {
  const found = await readCredentials(ctx, 'apollo')
  if (!found?.secret) {
    throw new Error('Apollo is not connected. Add an API key in Settings, under Integrations.')
  }
  return found
}

const headers = (key: string) => ({ 'x-api-key': key })

export const testApollo = async (ctx: WorkspaceContext): Promise<ConnectionTest> => {
  try {
    if (devIntegrationsEnabled) {
      await recordHealth(ctx, 'apollo', { ok: true })
      return { ok: true, detail: 'Development provider. No key is being used and nothing leaves this machine.' }
    }
    const { secret } = await credentials(ctx)
    const health = await json<{ is_logged_in?: boolean }>({
      url: `${API}/auth/health`,
      headers: headers(secret!),
    })
    if (health.is_logged_in === false) {
      throw new Error('Apollo accepted the request but reports the key is not logged in.')
    }
    await recordHealth(ctx, 'apollo', { ok: true })
    return { ok: true, detail: 'Connected. Apollo accepted the key.' }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await recordHealth(ctx, 'apollo', {
      ok: false,
      error: message,
      disconnected: (cause as { disconnected?: boolean }).disconnected === true,
    })
    return { ok: false, detail: message }
  }
}

export type ApolloPerson = {
  first_name?: string | null
  last_name?: string | null
  title?: string | null
  linkedin_url?: string | null
  organization?: {
    name?: string | null
    website_url?: string | null
    industry?: string | null
    estimated_num_employees?: number | null
    annual_revenue?: number | null
    city?: string | null
    country?: string | null
  } | null
}

/** F6 §4's field list, exactly: industry, location, size, revenue, and the company
 *  identity. Mapped onto the registry's keys here so the enrichment layer never has
 *  to know a provider's vocabulary. */
export const contactFieldsFrom = (person: ApolloPerson): Record<string, unknown> => ({
  first_name: person.first_name ?? undefined,
  last_name: person.last_name ?? undefined,
  title: person.title ?? undefined,
  linkedin_url: person.linkedin_url ?? undefined,
})

export const companyFieldsFrom = (person: ApolloPerson): Record<string, unknown> => ({
  name: person.organization?.name ?? undefined,
  domain: person.organization?.website_url ?? undefined,
  industry: person.organization?.industry ?? undefined,
  employee_count: person.organization?.estimated_num_employees ?? undefined,
  annual_revenue: person.organization?.annual_revenue ?? undefined,
  city: person.organization?.city ?? undefined,
  country: person.organization?.country ?? undefined,
})

export type EnrichOutcome = {
  provider: 'apollo'
  matched: boolean
  written: string[]
  suggested: string[]
  detail: string
}

/** Enriches one contact, and its company where Apollo knows one.
 *
 *  A miss is a real answer: fields stay blank, the record says so, and it is not
 *  retried on a loop. Blank is correct; invented data is not. F6 §4. */
export const enrichContact = async (
  ctx: WorkspaceContext,
  input: { contactId: string; email: string; companyId: string | null },
): Promise<EnrichOutcome> => {
  const person = devIntegrationsEnabled
    ? devPerson(input.email)
    : await (async () => {
        const { secret } = await credentials(ctx)
        const answer = await attempt(
          { ctx, kind: 'apollo', jobName: 'apollo.enrich', payload: { contactId: input.contactId } },
          () =>
            json<{ person?: ApolloPerson }>({
              url: `${API}/people/match`,
              method: 'POST',
              headers: headers(secret!),
              body: { email: input.email, reveal_personal_emails: false },
            }),
        )
        return answer.person ?? null
      })()

  if (!person) {
    await recordHealth(ctx, 'apollo', { ok: true })
    return {
      provider: 'apollo',
      matched: false,
      written: [],
      suggested: [],
      detail: `Apollo has no match for ${input.email}. The fields stay blank rather than being guessed.`,
    }
  }

  const contactResult = await applyEnrichment(ctx, {
    objectKey: 'contact',
    entityId: input.contactId,
    provider: 'apollo',
    values: contactFieldsFrom(person),
  })

  const companyResult = input.companyId
    ? await applyEnrichment(ctx, {
        objectKey: 'company',
        entityId: input.companyId,
        provider: 'apollo',
        values: companyFieldsFrom(person),
      })
    : { written: [], suggested: [] }

  await recordHealth(ctx, 'apollo', { ok: true })
  const written = [...contactResult.written, ...companyResult.written]
  const suggested = [...contactResult.suggested, ...companyResult.suggested]

  return {
    provider: 'apollo',
    matched: true,
    written,
    suggested,
    detail:
      written.length === 0 && suggested.length === 0
        ? 'Apollo matched but had nothing new to add.'
        : `${written.length} field${written.length === 1 ? '' : 's'} filled, ${suggested.length} left as a suggestion because a person had already entered a different value.`,
  }
}

type ApolloWebhook = {
  id?: string
  event_type?: string
  email?: string
  subject?: string
  timestamp?: string
  sequence_name?: string
  step?: number
  link_url?: string
}

const EVENT_MAP: Record<string, MarketingEvent['kind']> = {
  email_opened: 'open',
  email_clicked: 'click',
  email_bounced: 'bounce',
  email_delivered: 'delivered',
  email_replied: 'sequence_reply',
  sequence_step_completed: 'sequence_step',
  sequence_finished: 'sequence_step',
}

export const handleApolloWebhook = async (
  ctx: WorkspaceContext,
  body: unknown,
): Promise<{ handled: boolean; detail: string }> => {
  const event = body as ApolloWebhook
  const kind = EVENT_MAP[event.event_type ?? '']
  if (!kind) return { handled: false, detail: `Apollo event "${event.event_type}" is not one Rawr records.` }
  if (!event.email) return { handled: false, detail: 'That event carried no address.' }

  const outcome = await ingestMarketingEvent(ctx, {
    source: 'apollo',
    providerEventId: event.id ?? `${event.email}:${event.event_type}:${event.timestamp ?? ''}`,
    kind,
    email: event.email,
    subject: event.subject ?? event.sequence_name ?? 'an email',
    at: event.timestamp ? new Date(event.timestamp) : new Date(),
    detail: {
      sequence: event.sequence_name ?? null,
      step: event.step ?? null,
      link: event.link_url ?? null,
    },
  })

  await recordHealth(ctx, 'apollo', { ok: true })
  return { handled: outcome.stored, detail: outcome.reason ?? 'Recorded on the contact timeline.' }
}

// ------------------------------------------------------------ companies

export type ApolloOrganization = NonNullable<ApolloPerson['organization']>

/** A company with no contact yet is still enrichable: Apollo matches it on its
 *  domain. Same field list, same provenance rules. F6 §4. */
export const enrichCompany = async (
  ctx: WorkspaceContext,
  input: { companyId: string; domain: string },
): Promise<EnrichOutcome> => {
  const organization = devIntegrationsEnabled
    ? (devPerson(`someone@${input.domain}`)?.organization ?? null)
    : await (async () => {
        const { secret } = await credentials(ctx)
        const answer = await attempt(
          { ctx, kind: 'apollo', jobName: 'apollo.enrich_company', payload: { companyId: input.companyId } },
          () =>
            json<{ organization?: ApolloOrganization | null }>({
              url: `${API}/organizations/enrich?domain=${encodeURIComponent(input.domain)}`,
              headers: headers(secret!),
            }),
        )
        return answer.organization ?? null
      })()

  if (!organization) {
    await recordHealth(ctx, 'apollo', { ok: true })
    return {
      provider: 'apollo',
      matched: false,
      written: [],
      suggested: [],
      detail: `Apollo has no company for ${input.domain}. The fields stay blank rather than being guessed.`,
    }
  }

  const result = await applyEnrichment(ctx, {
    objectKey: 'company',
    entityId: input.companyId,
    provider: 'apollo',
    values: companyFieldsFrom({ organization }),
  })
  await recordHealth(ctx, 'apollo', { ok: true })
  return {
    provider: 'apollo',
    matched: true,
    written: result.written,
    suggested: result.suggested,
    detail:
      result.written.length === 0 && result.suggested.length === 0
        ? 'Apollo matched the company but had nothing new to add.'
        : `${result.written.length} company field${result.written.length === 1 ? '' : 's'} filled, ${result.suggested.length} left as a suggestion.`,
  }
}

// ------------------------------------------------------------ sequences

export type ApolloSequence = { id: string; name: string; active: boolean }
export type ApolloEmailAccount = { id: string; email: string; active: boolean }

export const listSequences = async (ctx: WorkspaceContext): Promise<ApolloSequence[]> => {
  if (devIntegrationsEnabled) return DEV_SEQUENCES
  const { secret } = await credentials(ctx)
  const answer = await json<{ emailer_campaigns?: { id: string; name: string; active?: boolean; archived?: boolean }[] }>({
    url: `${API}/emailer_campaigns/search?per_page=100`,
    method: 'POST',
    headers: headers(secret!),
    body: {},
  })
  return (answer.emailer_campaigns ?? [])
    .filter((row) => !row.archived)
    .map((row) => ({ id: row.id, name: row.name, active: row.active !== false }))
}

export const listEmailAccounts = async (ctx: WorkspaceContext): Promise<ApolloEmailAccount[]> => {
  if (devIntegrationsEnabled) return DEV_ACCOUNTS
  const { secret } = await credentials(ctx)
  const answer = await json<{ email_accounts?: { id: string; email: string; active?: boolean }[] }>({
    url: `${API}/email_accounts`,
    headers: headers(secret!),
  })
  return (answer.email_accounts ?? []).map((row) => ({ id: row.id, email: row.email, active: row.active !== false }))
}

/** Apollo's own id for a Rawr contact, creating the Apollo contact when it has
 *  none. Deduplicated on their side by email, and remembered here so the next
 *  call is a lookup, not a create. */
const apolloContactId = async (ctx: WorkspaceContext, contactId: string): Promise<{ id: string; email: string }> => {
  const record = await getRecord(ctx, 'contact', contactId)
  const email = typeof record?.values.email === 'string' ? record.values.email : ''
  if (!record || !email) throw new Error('Apollo matches on email, and this contact has none.')

  const known = await externalIdOf(ctx, contactId, 'apollo')
  if (known) return { id: known, email }

  const id = devIntegrationsEnabled
    ? `dev-apollo-${contactId.slice(0, 8)}`
    : await (async () => {
        const { secret } = await credentials(ctx)
        const answer = await attempt(
          { ctx, kind: 'apollo', jobName: 'apollo.create_contact', payload: { contactId } },
          () =>
            json<{ contact?: { id?: string } }>({
              url: `${API}/contacts`,
              method: 'POST',
              headers: headers(secret!),
              body: {
                email,
                first_name: record.values.first_name ?? undefined,
                last_name: record.values.last_name ?? undefined,
                title: record.values.title ?? undefined,
                run_dedupe: true,
              },
            }),
        )
        if (!answer.contact?.id) throw new Error('Apollo accepted the contact but returned no id for it.')
        return answer.contact.id
      })()

  await setExternalId(ctx, contactId, 'apollo', id)
  return { id, email }
}

/** Reading back what Apollo's own sequences did, for anybody still running one
 *  there. Rawr sends its own sequences now, from the member's Gmail, so there is
 *  no enrol here any more: the mail Apollo sends does not thread with the rest of
 *  the conversation and does not stop when somebody replies to us. What Apollo
 *  already has in flight still reaches the timeline through the sync below. */

export type SequenceStatus = {
  sequenceId: string
  sequenceName: string
  status: string
  currentStep: number | null
  addedAt: string | null
  failureReason: string | null
}

const ACTIVITY_KIND: Record<string, MarketingEvent['kind']> = {
  enrolled: 'sequence_step',
  completed: 'sequence_step',
  failed: 'sequence_step',
  paused: 'sequence_step',
  resumed: 'sequence_step',
  removed: 'sequence_step',
  replied: 'sequence_reply',
  // The email tracking row: Apollo's own opens and clicks, read back per message.
  delivered: 'sequence_step',
  opened: 'open',
  clicked: 'click',
  bounced: 'sequence_step',
}

/** The read-back F6 §3 promises: where each sequence got to, and every event on
 *  the way, written once each onto the contact timeline. */
export const syncSequenceActivity = async (
  ctx: WorkspaceContext,
  contactId: string,
): Promise<{ statuses: SequenceStatus[]; recorded: number }> => {
  const apollo = await apolloContactId(ctx, contactId)
  const sequences = await listSequences(ctx)
  const nameOf = new Map(sequences.map((row) => [row.id, row.name]))

  const { statuses, events } = devIntegrationsEnabled
    ? devActivity()
    : await (async () => {
        const { secret } = await credentials(ctx)
        // Two documented reads. Where each sequence got to is on the contact
        // itself; what each email did is the outreach-email search, which has no
        // contact filter, so the keyword is the address and the recipient is
        // checked on every row that comes back.
        const [found, mail] = await Promise.all([
          json<{ contacts?: { id: string; contact_campaign_statuses?: RawStatus[] }[] }>({
            url: `${API}/contacts/search`,
            method: 'POST',
            headers: headers(secret!),
            body: { q_keywords: apollo.email, per_page: 5 },
          }),
          json<{ emailer_messages?: RawMessage[] }>({
            url: `${API}/emailer_messages/search?${new URLSearchParams({ q_keywords: apollo.email, per_page: '100' }).toString()}`,
            headers: headers(secret!),
          }),
        ])
        const contact = (found.contacts ?? []).find((row) => row.id === apollo.id)
        const statuses = contact?.contact_campaign_statuses ?? []
        const events: RawEvent[] = []
        for (const status of statuses) {
          if (status.added_at) events.push({ type: 'enrolled', occurred_at: status.added_at, sequence_id: status.emailer_campaign_id })
          if (status.status === 'finished' && status.finished_at) events.push({ type: 'completed', occurred_at: status.finished_at, sequence_id: status.emailer_campaign_id })
          if (status.status === 'failed' && status.failure_reason) {
            events.push({ type: 'failed', occurred_at: status.finished_at ?? status.added_at ?? new Date().toISOString(), sequence_id: status.emailer_campaign_id, reason: status.failure_reason })
          }
          if (status.status === 'paused' && status.paused_at) events.push({ type: 'paused', occurred_at: status.paused_at, sequence_id: status.emailer_campaign_id })
        }
        for (const message of mail.emailer_messages ?? []) {
          if ((message.to_email ?? '').toLowerCase() !== apollo.email.toLowerCase()) continue
          const at = message.completed_at ?? message.created_at
          if (!at) continue
          const base = { occurred_at: at, sequence_id: message.emailer_campaign_id ?? '', step_position: message.emailer_step?.position, message_id: message.id, subject: message.subject ?? undefined }
          if (['delivered', 'opened', 'clicked', 'replied'].includes(message.status ?? '')) events.push({ ...base, type: 'delivered' })
          if (message.status === 'opened' || message.status === 'clicked' || message.status === 'replied') events.push({ ...base, type: 'opened' })
          if (message.status === 'clicked') events.push({ ...base, type: 'clicked' })
          if (message.status === 'replied') events.push({ ...base, type: 'replied' })
          if (message.status === 'bounced') events.push({ ...base, type: 'bounced' })
        }
        return { statuses, events }
      })()

  let recorded = 0
  for (const event of events) {
    const kind = ACTIVITY_KIND[event.type]
    if (!kind) continue
    const name = event.sequence_name ?? nameOf.get(event.sequence_id) ?? 'a sequence'
    const outcome = await ingestMarketingEvent(ctx, {
      source: 'apollo',
      providerEventId: event.message_id
        ? `msg:${event.message_id}:${event.type}`
        : `${apollo.id}:${event.sequence_id}:${event.type}:${event.occurred_at}`,
      kind,
      email: apollo.email,
      // An open, a click or a send is about one email; the rest is about the sequence.
      // A one-off email sent from Apollo has no sequence at all, so its subject is
      // the only name it has.
      subject: (kind === 'open' || kind === 'click' || event.type === 'delivered' || !event.sequence_id) && event.subject ? event.subject : name,
      at: new Date(event.occurred_at),
      detail: {
        sequence: name,
        sequenceId: event.sequence_id,
        step: event.step_position ?? null,
        event: event.type === 'delivered' ? 'sent' : event.type === 'bounced' ? 'failed' : event.type,
        reason: event.reason ?? null,
      },
    })
    if (outcome.stored) recorded += 1
  }

  await setExternalId(ctx, contactId, 'apollo:synced_at', new Date().toISOString())
  await recordHealth(ctx, 'apollo', { ok: true })

  return {
    recorded,
    statuses: statuses.map((row) => ({
      sequenceId: row.emailer_campaign_id,
      sequenceName: nameOf.get(row.emailer_campaign_id) ?? 'Unknown sequence',
      status: row.status,
      currentStep: row.current_step_position ?? null,
      addedAt: row.added_at ?? null,
      failureReason: row.failure_reason ?? null,
    })),
  }
}

type RawStatus = {
  emailer_campaign_id: string
  status: string
  current_step_position?: number | null
  added_at?: string | null
  finished_at?: string | null
  paused_at?: string | null
  failure_reason?: string | null
}

type RawMessage = {
  id: string
  status?: string | null
  subject?: string | null
  to_email?: string | null
  created_at?: string | null
  completed_at?: string | null
  emailer_campaign_id?: string | null
  emailer_step?: { position?: number } | null
}

type RawEvent = {
  type: string
  occurred_at: string
  sequence_id: string
  sequence_name?: string
  step_position?: number | undefined
  reason?: string
  message_id?: string
  subject?: string | undefined
}

/** The scheduled pass: every contact Apollo knows, a page at a time. Each contact
 *  is its own call so one failure is one failure, not a stalled workspace. */
export const syncLinkedContacts = async (
  ctx: WorkspaceContext,
  limit = 100,
): Promise<{ contacts: number; recorded: number; failed: string[] }> => {
  const linked = await contactsLinkedTo(ctx, 'apollo', limit)
  let recorded = 0
  const failed: string[] = []
  for (const contact of linked) {
    try {
      recorded += (await syncSequenceActivity(ctx, contact.id)).recorded
    } catch (cause) {
      failed.push(`${contact.email}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  return { contacts: linked.length, recorded, failed }
}

const DEV_SEQUENCES: ApolloSequence[] = [
  { id: 'dev-seq-1', name: 'Trial follow-up', active: true },
  { id: 'dev-seq-2', name: 'Re-engage dormant leads', active: true },
]

const DEV_ACCOUNTS: ApolloEmailAccount[] = [{ id: 'dev-acct-1', email: 'sales@datasaur.ai', active: true }]

/** Fixed timestamps, so a second sync records nothing new: the same property a
 *  real feed has, and the one the timeline dedupe is tested against. */
const devActivity = (): { statuses: RawStatus[]; events: RawEvent[] } => {
  const base = new Date('2026-08-20T09:00:00Z').getTime()
  const day = 24 * 60 * 60 * 1000
  return {
    statuses: [{ emailer_campaign_id: 'dev-seq-1', status: 'active', current_step_position: 2, added_at: new Date(base).toISOString() }],
    events: [
      { type: 'enrolled', occurred_at: new Date(base).toISOString(), sequence_id: 'dev-seq-1', sequence_name: 'Trial follow-up', step_position: 1 },
      { type: 'replied', occurred_at: new Date(base + day).toISOString(), sequence_id: 'dev-seq-1', sequence_name: 'Trial follow-up' },
    ],
  }
}

/** The link out. Rawr does not send sequence email, so the useful thing it can do
 *  is put somebody in front of the right Apollo screen in one click. F6 §3. */
export const apolloContactUrl = (email: string): string =>
  `https://app.apollo.io/#/people?finderViewId=&prospectedByCurrentTeam[]=no&qKeywords=${encodeURIComponent(email)}`

/** A fixed match so the enrichment rules — fill a blank, refuse to overwrite a
 *  human, record provenance — are exercisable without an Apollo key. */
const devPerson = (email: string): ApolloPerson | null => {
  if (email.includes('nomatch')) return null
  const domain = email.split('@')[1] ?? 'example.com'
  return {
    first_name: 'Dev',
    last_name: 'Match',
    title: 'Head of Data',
    linkedin_url: `https://www.linkedin.com/in/${email.split('@')[0]}`,
    organization: {
      name: domain.split('.')[0] ?? domain,
      website_url: domain,
      industry: 'Software',
      estimated_num_employees: 240,
      annual_revenue: 18_000_000,
      city: 'San Francisco',
      country: 'United States',
    },
  }
}
