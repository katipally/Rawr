import { applyEnrichment, readCredentials, recordHealth, type WorkspaceContext } from '@rawr/db'
import { devIntegrationsEnabled } from '~/lib/env.ts'
import { attempt, json, type ConnectionTest } from './provider.ts'

/** B5. The third enricher, between Apollo and Clay.
 *
 *  Lusha's v3 API is search-then-enrich: a search by email or domain returns a
 *  match with no personal data in it, and enriching that match is what costs a
 *  credit. `search-and-enrich` does both in one call, which is what this uses,
 *  because two round trips per contact is two chances to half-fail.
 *
 *  Only what Apollo left blank is ever asked for. A credit spent re-answering a
 *  question that already has an answer is a credit wasted, and the configured
 *  order is Apollo, then Lusha, then Clay. */

const API = 'https://api.lusha.com/v3'

const credentials = async (ctx: WorkspaceContext) => {
  const found = await readCredentials(ctx, 'lusha')
  if (!found?.secret) {
    throw new Error('Lusha is not connected. Add an API key in Settings, under Integrations.')
  }
  return found
}

const headers = (key: string) => ({ api_key: key })

export const testLusha = async (ctx: WorkspaceContext): Promise<ConnectionTest> => {
  try {
    if (devIntegrationsEnabled) {
      await recordHealth(ctx, 'lusha', { ok: true })
      return { ok: true, detail: 'Development provider. No key is being used and nothing leaves this machine.' }
    }
    const { secret } = await credentials(ctx)
    // The usage endpoint is the one call that reads the account without spending
    // a credit, so the test says what the plan has left rather than burning some
    // of it to prove the key works.
    const usage = await json<{ credits?: { available?: number; used?: number } }>({
      url: `${API}/account/usage`,
      headers: headers(secret!),
    })
    await recordHealth(ctx, 'lusha', { ok: true })
    const left = usage.credits?.available
    return {
      ok: true,
      detail:
        typeof left === 'number'
          ? `Connected. ${left.toLocaleString()} credits left on this plan.`
          : 'Connected. Lusha accepted the key.',
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await recordHealth(ctx, 'lusha', {
      ok: false,
      error: message,
      disconnected: (cause as { disconnected?: boolean }).disconnected === true,
    })
    return { ok: false, detail: message }
  }
}

export type LushaOutcome = {
  provider: 'lusha'
  matched: boolean
  written: string[]
  suggested: string[]
  detail: string
}

const miss = (detail: string): LushaOutcome => ({
  provider: 'lusha',
  matched: false,
  written: [],
  suggested: [],
  detail,
})

/** Lusha returns a contact under `data`, and its company nested or alongside
 *  depending on which call answered. Read defensively: a field that is not where
 *  it was expected is a blank, never a crash, and never a guess. */
type LushaContact = {
  firstName?: string | null
  lastName?: string | null
  jobTitle?: string | null
  linkedinUrl?: string | null
  emailAddresses?: { email?: string | null }[] | null
  phoneNumbers?: { number?: string | null }[] | null
  company?: LushaCompany | null
}

type LushaCompany = {
  name?: string | null
  domain?: string | null
  website?: string | null
  industry?: string | null
  employees?: number | null
  size?: number | string | null
  revenue?: number | string | null
  location?: { city?: string | null; country?: string | null } | null
  locations?: { city?: string | null; country?: string | null }[] | null
}

const firstOf = <T>(list: T[] | null | undefined): T | undefined => (list ?? [])[0]

const numeric = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  // Lusha writes ranges like "51-200" and "$10M-$50M". The bottom of the range is
  // the only number that is certainly true of the company.
  const found = value.replace(/,/g, '').match(/\d+(\.\d+)?/)
  if (!found) return undefined
  const scale = /m/i.test(value) ? 1_000_000 : /b/i.test(value) ? 1_000_000_000 : 1
  return Number(found[0]) * scale
}

export const contactFieldsFrom = (person: LushaContact): Record<string, unknown> => ({
  first_name: person.firstName ?? undefined,
  last_name: person.lastName ?? undefined,
  title: person.jobTitle ?? undefined,
  linkedin_url: person.linkedinUrl ?? undefined,
  phone: firstOf(person.phoneNumbers)?.number ?? undefined,
})

export const companyFieldsFrom = (company: LushaCompany | null | undefined): Record<string, unknown> => {
  if (!company) return {}
  const where = company.location ?? firstOf(company.locations)
  return {
    name: company.name ?? undefined,
    domain: company.domain ?? company.website ?? undefined,
    industry: company.industry ?? undefined,
    employee_count: numeric(company.employees ?? company.size),
    annual_revenue: numeric(company.revenue),
    city: where?.city ?? undefined,
    country: where?.country ?? undefined,
  }
}

const onlyWanted = (values: Record<string, unknown>, wanted: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(values).filter(([key]) => wanted.includes(key)))

const devContact: LushaContact = {
  firstName: 'Dev',
  lastName: 'Person',
  jobTitle: 'Head of Data',
  linkedinUrl: 'https://linkedin.com/in/dev-person',
  phoneNumbers: [{ number: '+1 555 0100' }],
  company: {
    name: 'Development Co',
    industry: 'Software',
    size: '51-200',
    revenue: '$10M',
    location: { city: 'Amsterdam', country: 'Netherlands' },
  },
}

/** One person, by email, and their company where Lusha knows one. */
export const enrichContactWithLusha = async (
  ctx: WorkspaceContext,
  input: { contactId: string; email: string; companyId: string | null; missing: string[] },
): Promise<LushaOutcome> => {
  if (input.missing.length === 0) return miss('Nothing was left for Lusha to fill.')

  let person: LushaContact | null = devContact
  if (!devIntegrationsEnabled) {
    const { secret } = await credentials(ctx)
    const answer = await attempt(
      { ctx, kind: 'lusha', jobName: 'lusha.enrich', payload: { contactId: input.contactId } },
      () =>
        json<{ data?: LushaContact[] }>({
          url: `${API}/contacts/search-and-enrich`,
          method: 'POST',
          headers: headers(secret!),
          body: { contacts: [{ email: input.email }] },
        }),
    )
    person = firstOf(answer.data) ?? null
  }

  if (!person) {
    await recordHealth(ctx, 'lusha', { ok: true })
    return miss(`Lusha has no record of ${input.email}.`)
  }

  const contact = await applyEnrichment(ctx, {
    objectKey: 'contact',
    entityId: input.contactId,
    provider: 'lusha',
    values: onlyWanted(contactFieldsFrom(person), input.missing),
  })
  const written = [...contact.written]
  const suggested = [...contact.suggested]

  if (input.companyId) {
    const company = await applyEnrichment(ctx, {
      objectKey: 'company',
      entityId: input.companyId,
      provider: 'lusha',
      values: onlyWanted(companyFieldsFrom(person.company), input.missing),
    })
    written.push(...company.written)
    suggested.push(...company.suggested)
  }

  await recordHealth(ctx, 'lusha', { ok: true })
  return {
    provider: 'lusha',
    matched: true,
    written,
    suggested,
    detail: `Lusha matched ${input.email}: ${written.length} filled, ${suggested.length} left as a suggestion.`,
  }
}

/** A company on its own, by domain. */
export const enrichCompanyWithLusha = async (
  ctx: WorkspaceContext,
  input: { companyId: string; domain: string; missing: string[] },
): Promise<LushaOutcome> => {
  if (input.missing.length === 0) return miss('Nothing was left for Lusha to fill.')

  let company: LushaCompany | null = devContact.company ?? null
  if (!devIntegrationsEnabled) {
    const { secret } = await credentials(ctx)
    const answer = await attempt(
      { ctx, kind: 'lusha', jobName: 'lusha.enrich', payload: { companyId: input.companyId } },
      () =>
        json<{ data?: LushaCompany[] }>({
          url: `${API}/companies/search-and-enrich`,
          method: 'POST',
          headers: headers(secret!),
          body: { companies: [{ domain: input.domain }] },
        }),
    )
    company = firstOf(answer.data) ?? null
  }

  if (!company) {
    await recordHealth(ctx, 'lusha', { ok: true })
    return miss(`Lusha has no record of ${input.domain}.`)
  }

  const result = await applyEnrichment(ctx, {
    objectKey: 'company',
    entityId: input.companyId,
    provider: 'lusha',
    values: onlyWanted(companyFieldsFrom(company), input.missing),
  })
  await recordHealth(ctx, 'lusha', { ok: true })
  return {
    provider: 'lusha',
    matched: true,
    written: result.written,
    suggested: result.suggested,
    detail: `Lusha matched ${input.domain}: ${result.written.length} filled, ${result.suggested.length} left as a suggestion.`,
  }
}
