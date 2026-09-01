import { applyEnrichment, readCredentials, recordHealth, type WorkspaceContext } from '@rawr/db'
import { devIntegrationsEnabled } from '~/lib/env.ts'
import { attempt, json, type ConnectionTest } from './provider.ts'

/** F6 §4, the second enricher. Apollo first, Clay for what is missing.
 *
 *  Two things the doc insists are said plainly, and they shape this file:
 *
 *  Clay is not installed in HubSpot at all. Clearbit, now HubSpot Breeze
 *  Intelligence, and Seamless.AI are what populate company fields today, and if
 *  Clearbit is bundled with the HubSpot contract it dies with it.
 *
 *  The Clay tier is unconfirmed. Webhook and HTTP API sync are Growth-tier
 *  features. On Launch there is no write-back into a homegrown CRM and this
 *  degrades to CSV round-trips. That degradation is a visible state here, not a
 *  silent no-op: `tier: 'launch'` in the config makes every call refuse with the
 *  reason rather than pretending to work. Open items 12 to 14. */

type ClayConfig = { tier?: 'launch' | 'growth'; webhookUrl?: string }

export const clayDegraded = (config: ClayConfig): string | null =>
  config.tier === 'launch'
    ? 'This Clay account is on Launch, where webhook and HTTP API sync do not exist. Enrichment through Clay is a CSV round trip until the tier changes.'
    : null

const credentials = async (ctx: WorkspaceContext) => {
  const found = await readCredentials(ctx, 'clay')
  if (!found?.secret) {
    throw new Error('Clay is not connected. Add an API key in Settings, under Integrations.')
  }
  return { ...found, config: found.config as ClayConfig }
}

export const testClay = async (ctx: WorkspaceContext): Promise<ConnectionTest> => {
  try {
    if (devIntegrationsEnabled) {
      await recordHealth(ctx, 'clay', { ok: true })
      return { ok: true, detail: 'Development provider. No key is being used and nothing leaves this machine.' }
    }
    const { config, secret } = await credentials(ctx)
    const degraded = clayDegraded(config)
    if (degraded) {
      await recordHealth(ctx, 'clay', { ok: false, error: degraded })
      return { ok: false, detail: degraded }
    }
    if (!config.webhookUrl) {
      const detail = 'Clay needs the webhook URL of the table Rawr should push into.'
      await recordHealth(ctx, 'clay', { ok: false, error: detail })
      return { ok: false, detail }
    }

    // Clay's table webhooks have no health endpoint, so the test is the smallest
    // real write the table can absorb, marked so a human can spot it.
    await json({
      url: config.webhookUrl,
      method: 'POST',
      headers: { 'x-clay-webhook-auth': secret! },
      body: { rawr_connection_test: true, at: new Date().toISOString() },
    })
    await recordHealth(ctx, 'clay', { ok: true })
    return { ok: true, detail: 'Clay accepted a test row into the configured table.' }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await recordHealth(ctx, 'clay', {
      ok: false,
      error: message,
      disconnected: (cause as { disconnected?: boolean }).disconnected === true,
    })
    return { ok: false, detail: message }
  }
}

export type ClayOutcome = {
  provider: 'clay'
  matched: boolean
  written: string[]
  suggested: string[]
  detail: string
}

/** Fills what Apollo left blank. `missing` is what the caller still wants, so Clay
 *  is never asked to re-answer a question Apollo already answered: F6 §4's
 *  "first non-empty by configured order wins". */
export const enrichWithClay = async (
  ctx: WorkspaceContext,
  input: { companyId: string; domain: string; missing: string[] },
): Promise<ClayOutcome> => {
  if (input.missing.length === 0) {
    return { provider: 'clay', matched: false, written: [], suggested: [], detail: 'Nothing was left for Clay to fill.' }
  }

  if (!devIntegrationsEnabled) {
    const { config, secret } = await credentials(ctx)
    const degraded = clayDegraded(config)
    if (degraded) {
      return { provider: 'clay', matched: false, written: [], suggested: [], detail: degraded }
    }
    if (!config.webhookUrl) {
      return {
        provider: 'clay',
        matched: false,
        written: [],
        suggested: [],
        detail: 'Clay has no table webhook configured, so there is nowhere to send the domain.',
      }
    }

    // Clay is asynchronous by design: the row is pushed and the answer comes back
    // as a webhook later. There is nothing to write here, and saying that is
    // better than reporting a match that has not happened yet.
    await attempt(
      { ctx, kind: 'clay', jobName: 'clay.enqueue', payload: { companyId: input.companyId } },
      () =>
        json({
          url: config.webhookUrl!,
          method: 'POST',
          headers: { 'x-clay-webhook-auth': secret! },
          body: { domain: input.domain, rawr_company_id: input.companyId, wanted: input.missing },
        }),
    )
    await recordHealth(ctx, 'clay', { ok: true })
    return {
      provider: 'clay',
      matched: false,
      written: [],
      suggested: [],
      detail: 'Sent to Clay. Its answer arrives as a webhook and lands on the record then.',
    }
  }

  const result = await applyEnrichment(ctx, {
    objectKey: 'company',
    entityId: input.companyId,
    provider: 'clay',
    values: Object.fromEntries(input.missing.map((key) => [key, devValue(key, input.domain)])),
  })
  await recordHealth(ctx, 'clay', { ok: true })
  return {
    provider: 'clay',
    matched: true,
    written: result.written,
    suggested: result.suggested,
    detail: `${result.written.length} filled, ${result.suggested.length} left as a suggestion.`,
  }
}

/** Clay's answer, arriving as a webhook against the company Rawr told it about. */
export const handleClayWebhook = async (
  ctx: WorkspaceContext,
  body: unknown,
): Promise<{ handled: boolean; detail: string }> => {
  const payload = body as { rawr_company_id?: string; fields?: Record<string, unknown> }
  if (!payload.rawr_company_id || !payload.fields) {
    return { handled: false, detail: 'That payload named no company, so there is nothing to write it to.' }
  }

  const result = await applyEnrichment(ctx, {
    objectKey: 'company',
    entityId: payload.rawr_company_id,
    provider: 'clay',
    values: payload.fields,
  })
  await recordHealth(ctx, 'clay', { ok: true })
  return {
    handled: true,
    detail: `${result.written.length} filled, ${result.suggested.length} held as a suggestion, ${result.unchanged.length} unchanged.`,
  }
}

const devValue = (key: string, domain: string): unknown => {
  if (key === 'industry') return 'Software'
  if (key === 'employee_count') return 180
  if (key === 'annual_revenue') return 12_000_000
  if (key === 'city') return 'Berlin'
  if (key === 'country') return 'Germany'
  if (key === 'name') return domain.split('.')[0]
  return undefined
}
