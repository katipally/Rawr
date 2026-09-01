import {
  applyEnrichment,
  ingestMarketingEvent,
  readCredentials,
  recordHealth,
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
