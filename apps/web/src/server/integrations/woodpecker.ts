import {
  ingestMarketingEvent,
  readCredentials,
  recordHealth,
  type MarketingEventKind,
  type AccountContext,
} from '@rawr/db'
import { devIntegrationsEnabled } from '~/lib/env.ts'
import { attempt, json, type ConnectionTest } from './provider.ts'

/** B5. Volume sending, for the runs Gmail's per-account caps cannot carry.
 *
 *  Woodpecker is not a transport Rawr drives step by step. A campaign there owns
 *  its own steps, its own delays and its own sending accounts; what Rawr does is
 *  hand it a prospect and then listen. So a sequence whose sender is Woodpecker
 *  has no steps of its own: it names a campaign, the enrollment hands the contact
 *  over once, and everything after that arrives as a webhook.
 *
 *  Saying that plainly is the point. A `Sender` that pretended to put each step on
 *  the wire would report sends that Woodpecker, not Rawr, decides whether to make. */

const API = 'https://api.woodpecker.co/rest/v1'

type WoodpeckerConfig = { campaignId?: number; webhookToken?: string }

const credentials = async (ctx: AccountContext) => {
  const found = await readCredentials(ctx, 'woodpecker')
  if (!found?.secret) {
    throw new Error('Woodpecker is not connected. Add an API key in Settings, under Integrations.')
  }
  return { ...found, config: found.config as WoodpeckerConfig }
}

const headers = (key: string) => ({ 'x-api-key': key })

export type WoodpeckerCampaign = {
  id: number
  name: string
  status: string
  fromEmail: string | null
  perDay: number | null
}

const DEV_CAMPAIGNS: WoodpeckerCampaign[] = [
  { id: 101, name: 'Development outbound', status: 'RUNNING', fromEmail: 'dev@datasaur.ai', perDay: 50 },
  { id: 102, name: 'Development nurture', status: 'PAUSED', fromEmail: 'dev@datasaur.ai', perDay: 25 },
]

/** The campaigns a sequence can point at. Woodpecker answers 204 with no body when
 *  the account has none, which is an empty list rather than a failure. */
export const listWoodpeckerCampaigns = async (ctx: AccountContext): Promise<WoodpeckerCampaign[]> => {
  if (devIntegrationsEnabled) return DEV_CAMPAIGNS
  const { secret } = await credentials(ctx)
  const rows = await attempt(
    { ctx, kind: 'woodpecker', jobName: 'woodpecker.campaigns', payload: {} },
    () =>
      json<
        { id: number; name: string; status?: string; from_email?: string; per_day?: number }[] | null
      >({ url: `${API}/campaign_list`, headers: headers(secret!) }),
  )
  await recordHealth(ctx, 'woodpecker', { ok: true })
  return (rows ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status ?? 'UNKNOWN',
    fromEmail: row.from_email ?? null,
    perDay: row.per_day ?? null,
  }))
}

export const testWoodpecker = async (ctx: AccountContext): Promise<ConnectionTest> => {
  try {
    if (devIntegrationsEnabled) {
      await recordHealth(ctx, 'woodpecker', { ok: true })
      return { ok: true, detail: 'Development provider. No key is being used and nothing leaves this machine.' }
    }
    // Asked before the call, so an account nobody has connected reads as "no key
    // entered" rather than as Woodpecker rejecting one. A 401 on this card used to
    // mean an empty integration row, which sent people looking for a revoked key
    // that had never existed.
    const stored = await readCredentials(ctx, 'woodpecker')
    if (!stored?.secret) {
      const detail = 'No key entered yet. Paste a Woodpecker API key below and test again.'
      await recordHealth(ctx, 'woodpecker', { ok: false, error: detail })
      return { ok: false, detail }
    }
    const campaigns = await listWoodpeckerCampaigns(ctx)
    return {
      ok: true,
      detail:
        campaigns.length === 0
          ? 'Connected. This Woodpecker account has no campaigns yet, so there is nothing to enroll into.'
          : `Connected. ${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'} available.`,
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await recordHealth(ctx, 'woodpecker', {
      ok: false,
      error: message,
      disconnected: (cause as { disconnected?: boolean }).disconnected === true,
    })
    return { ok: false, detail: message }
  }
}

export type HandOver = {
  campaignId: number
  email: string
  firstName: string | null
  lastName: string | null
  companyName: string | null
}

/** Hands one prospect to a campaign.
 *
 *  Woodpecker rejects a prospect whose global status is not ACTIVE, which is how
 *  somebody who already replied or bounced stays out of a second campaign. That
 *  refusal is deliberately not overridden with `force`: the point of the status is
 *  that Rawr should not be able to mail somebody who asked it to stop. */
export const addProspect = async (
  ctx: AccountContext,
  input: HandOver,
): Promise<{ handed: boolean; detail: string }> => {
  if (devIntegrationsEnabled) {
    return { handed: true, detail: `Development provider: ${input.email} would go to campaign ${input.campaignId}.` }
  }

  const { secret } = await credentials(ctx)
  const answer = await attempt(
    { ctx, kind: 'woodpecker', jobName: 'woodpecker.enroll', payload: { ...input } },
    () =>
      json<{ prospects?: { prospect_campaign?: string }[]; status?: { status?: string; code?: string; msg?: string } }>({
        url: `${API}/add_prospects_campaign`,
        method: 'POST',
        headers: headers(secret!),
        body: {
          // Required by the API even for a first add; false only re-adds nothing.
          update: true,
          campaign: { campaign_id: input.campaignId },
          prospects: [
            {
              email: input.email,
              first_name: input.firstName ?? '',
              last_name: input.lastName ?? '',
              company: input.companyName ?? '',
            },
          ],
        },
      }),
  )

  await recordHealth(ctx, 'woodpecker', { ok: true })
  // The verdict is the response's own status block; a prospect already in the
  // campaign comes back as DUPLICATE, which is the outcome asked for, not a refusal.
  const verdict = answer.status?.status ?? 'OK'
  return verdict !== 'OK'
    ? { handed: false, detail: answer.status?.msg ?? `Woodpecker refused ${input.email} (${verdict}).` }
    : {
        handed: true,
        detail:
          answer.prospects?.[0]?.prospect_campaign === 'DUPLICATE'
            ? `${input.email} was already in Woodpecker campaign ${input.campaignId}.`
            : `${input.email} is in Woodpecker campaign ${input.campaignId}.`,
      }
}

/** Woodpecker posts an array of event objects, up to 100 at a time, because it
 *  batches events that share a type and a target URL. Anything Rawr does not have
 *  a contact for is counted and dropped, never invented. */
type WoodpeckerEvent = {
  event?: string
  event_type?: string
  prospect?: { email?: string; company?: string }
  email?: string
  campaign?: { campaign_id?: number; name?: string }
  campaign_id?: number
  event_time?: string
  timestamp?: string
  url?: string
}

/** Woodpecker's own vocabulary, mapped onto the event kinds every provider here
 *  already speaks. Events with no equivalent are counted and left alone rather
 *  than forced into the nearest one. */
const EVENT_MAP: Record<string, MarketingEventKind> = {
  campaign_sent: 'sequence_step',
  email_opened: 'open',
  link_clicked: 'click',
  prospect_replied: 'sequence_reply',
  prospect_bounced: 'bounce',
  prospect_opt_out: 'unsubscribe',
  campaign_completed: 'sequence_step',
}

/** Which opt-out a Woodpecker unsubscribe applies to. Woodpecker sends
 *  one-to-one sales mail, so silencing the newsletter too would be Rawr deciding
 *  something the recipient did not say. */
const OPT_OUT_TYPES = ['One-to-one sales email']

export const handleWoodpeckerWebhook = async (
  ctx: AccountContext,
  body: unknown,
): Promise<{ handled: boolean; detail: string }> => {
  const events: WoodpeckerEvent[] = Array.isArray(body) ? body : [body as WoodpeckerEvent]

  let written = 0
  let unmatched = 0
  let ignored = 0

  for (const event of events) {
    const name = event.event ?? event.event_type ?? ''
    const kind = EVENT_MAP[name]
    const email = event.prospect?.email ?? event.email ?? ''
    if (!kind || !email) {
      ignored += 1
      continue
    }

    const at = event.event_time ?? event.timestamp ?? ''
    const occurredAt = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : new Date()
    const campaignId = event.campaign?.campaign_id ?? event.campaign_id ?? null

    // Woodpecker retries anything it did not get a 2xx for, and its batching means
    // one event can arrive inside two deliveries. The id is what the event is
    // about rather than when it was delivered, so a retry writes nothing.
    const outcome = await ingestMarketingEvent(ctx, {
      source: 'woodpecker',
      providerEventId: `${name}:${campaignId ?? 'none'}:${email}:${occurredAt.toISOString()}`,
      kind,
      email,
      subject: event.campaign?.name ?? (campaignId ? `Woodpecker campaign ${campaignId}` : 'a Woodpecker campaign'),
      at: occurredAt,
      detail: {
        event: name === 'campaign_completed' ? 'completed' : name === 'campaign_sent' ? 'sent' : name,
        campaignId,
        link: event.url ?? null,
      },
      ...(kind === 'unsubscribe' ? { subscriptionTypes: OPT_OUT_TYPES } : {}),
    })

    if (!outcome.stored) ignored += 1
    else if (outcome.matched) written += 1
    else unmatched += 1
  }

  await recordHealth(ctx, 'woodpecker', { ok: true })
  return {
    handled: written > 0,
    detail: `${written} on the timeline, ${unmatched} with no matching contact, ${ignored} not acted on.`,
  }
}
