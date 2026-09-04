import {
  getRecord,
  ingestMarketingEvent,
  mailableContacts,
  once,
  readCredentials,
  readSegmentMembers,
  recordHealth,
  setExternalId,
  type MarketingEvent,
  type WorkspaceContext,
} from '@rawr/db'
import { createHash } from 'node:crypto'
import { devIntegrationsEnabled } from '~/lib/env.ts'
import { attempt, json, type ConnectionTest } from './provider.ts'

/** F6 §2. Newsletter, bought rather than built. ~1,800 recipients, roughly monthly.
 *
 *  Rawr owns the audience and the opt-out; Brevo owns the editor and the send.
 *  Nothing here triggers a campaign: marketing keeps its own tool for that, which
 *  is the whole reason this row is a buy and not a build. What crosses the boundary
 *  is a list of people Rawr says may be mailed, and a stream of events back.
 *
 *  Unsubscribe is authoritative in Rawr. A Brevo unsubscribe is imported as
 *  authoritative too; what never happens is Brevo claiming somebody is subscribed
 *  and that overwriting an opt-out recorded here. Nobody gets mailed after opting
 *  out, in either direction. */

const API = 'https://api.brevo.com/v3'

type BrevoConfig = { listId?: number; segmentId?: string; webhookToken?: string }

const credentials = async (ctx: WorkspaceContext) => {
  const found = await readCredentials(ctx, 'brevo')
  if (!found?.secret) {
    throw new Error('Brevo is not connected. Add an API key in Settings, under Integrations.')
  }
  return { ...found, config: found.config as BrevoConfig }
}

const headers = (key: string) => ({ 'api-key': key })

export const testBrevo = async (ctx: WorkspaceContext): Promise<ConnectionTest> => {
  try {
    if (devIntegrationsEnabled) {
      await recordHealth(ctx, 'brevo', { ok: true })
      return { ok: true, detail: 'Development provider. No key is being used and nothing leaves this machine.' }
    }
    const { secret } = await credentials(ctx)
    // The account endpoint is the cheapest call that proves the key is real, and
    // its answer names the account, which is what somebody wants to see.
    const account = await json<{ companyName?: string; email?: string; plan?: unknown[] }>({
      url: `${API}/account`,
      headers: headers(secret!),
    })
    await recordHealth(ctx, 'brevo', { ok: true })
    return {
      ok: true,
      detail: `Connected to ${account.companyName ?? account.email ?? 'the Brevo account'}.`,
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await recordHealth(ctx, 'brevo', {
      ok: false,
      error: message,
      disconnected: (cause as { disconnected?: boolean }).disconnected === true,
    })
    return { ok: false, detail: message }
  }
}

export type PushResult = { pushed: number; skipped: number; listId: number | null }

/** Pushes a Rawr segment into a Brevo list.
 *
 *  Two properties this must have and does: it never includes somebody who has opted
 *  out, and running it twice pushes each contact once. The idempotency key is
 *  derived from the segment and the contact set, so a retry of the same push is a
 *  no-op rather than a second upsert. F6 §1 and §2. */
export const pushSegmentToBrevo = async (
  ctx: WorkspaceContext,
  input: { segmentId: string; listId: number },
): Promise<PushResult> => {
  const { secret, config, id } = await credentials(ctx).catch((cause) => {
    if (devIntegrationsEnabled) return { secret: null, config: {} as BrevoConfig, id: null }
    throw cause
  })

  const members = await readSegmentMembers(ctx, input.segmentId, 200)
  const mailable = await mailableContacts(
    ctx,
    members.map((member) => member.id),
  )
  const skipped = members.length - mailable.length

  if (mailable.length === 0) {
    return { pushed: 0, skipped, listId: input.listId }
  }

  // Derived from what is being sent, never random: a retry produces the same key
  // and the second attempt returns the first one's answer.
  const key = `brevo:list:${input.listId}:${createHash('sha256')
    .update(mailable.map((row) => row.id).sort().join(','))
    .digest('hex')
    .slice(0, 32)}`

  await once(ctx, { key, operation: 'brevo.push_list', integrationId: id }, async () => {
    for (const contact of mailable) {
      if (devIntegrationsEnabled) {
        await setExternalId(ctx, contact.id, 'brevo', `dev-${contact.id.slice(0, 8)}`)
        continue
      }
      const created = await attempt(
        { ctx, kind: 'brevo', jobName: 'brevo.upsert_contact', payload: { contactId: contact.id } },
        () =>
          json<{ id?: number }>({
            url: `${API}/contacts`,
            method: 'POST',
            headers: headers(secret!),
            body: {
              email: contact.email,
              attributes: { FIRSTNAME: contact.firstName ?? '', LASTNAME: contact.lastName ?? '' },
              listIds: [input.listId],
              // The upsert. Without it a second push is a 400 per existing
              // contact rather than a no-op.
              updateEnabled: true,
            },
          }),
      )
      if (created?.id) await setExternalId(ctx, contact.id, 'brevo', String(created.id))
    }
    return { pushed: mailable.length }
  })

  await recordHealth(ctx, 'brevo', { ok: true })
  return { pushed: mailable.length, skipped, listId: input.listId ?? config.listId ?? null }
}

/** Brevo's webhook shape, narrowed to the events F6 §2 names. Anything else is
 *  acknowledged and ignored rather than refused, because a 4xx would make Brevo
 *  retry something we will never want. */
type BrevoWebhook = {
  event?: string
  email?: string
  /** Transactional deliveries carry a message id; campaign events carry the
   *  campaign id and its name under a key with a space in it. */
  'message-id'?: string
  camp_id?: number
  'campaign name'?: string
  id?: number
  subject?: string
  date?: string
  date_event?: string
  ts_event?: number
  tag?: string
  link?: string
  URL?: string
}

/** Both vocabularies: the campaign webhooks say `unsubscribe` and `click`, the
 *  transactional ones `unsubscribed` and `unique_opened`. A proxy open is Apple
 *  Mail fetching the pixel; it counts as an open the way HubSpot counts it. */
const EVENT_MAP: Record<string, MarketingEvent['kind']> = {
  delivered: 'delivered',
  unique_opened: 'open',
  opened: 'open',
  proxy_open: 'open',
  click: 'click',
  clicked: 'click',
  hard_bounce: 'bounce',
  soft_bounce: 'bounce',
  hardBounce: 'bounce',
  softBounce: 'bounce',
  spam: 'spam',
  unsubscribe: 'unsubscribe',
  unsubscribed: 'unsubscribe',
}

export const handleBrevoWebhook = async (
  ctx: WorkspaceContext,
  body: unknown,
): Promise<{ handled: boolean; detail: string }> => {
  const event = body as BrevoWebhook
  const kind = EVENT_MAP[event.event ?? '']
  if (!kind) return { handled: false, detail: `Brevo event "${event.event}" is not one Rawr records.` }
  if (!event.email) return { handled: false, detail: 'That event carried no address.' }

  const outcome = await ingestMarketingEvent(ctx, {
    source: 'brevo',
    // Brevo's own id for the delivery, plus the event name: one message produces
    // a delivered, an open and a click, and all three must survive deduplication.
    // A campaign fans out to every recipient under one camp_id, so the address is
    // part of the key; one message produces a delivered, an open and a click, so
    // the event name is too.
    providerEventId: `${event.camp_id ?? event['message-id'] ?? event.id ?? 'unknown'}:${event.email.toLowerCase()}:${event.event}`,
    kind,
    email: event.email,
    subject: event['campaign name'] ?? event.subject ?? event.tag ?? 'a newsletter',
    at: event.ts_event
      ? new Date(event.ts_event * 1000)
      : event.date_event || event.date
        ? new Date((event.date_event ?? event.date) as string)
        : new Date(),
    detail: { link: event.URL ?? event.link ?? null, tag: event.tag ?? null, campaignId: event.camp_id ?? null },
  })

  await recordHealth(ctx, 'brevo', { ok: true })
  return { handled: outcome.stored, detail: outcome.reason ?? 'Recorded on the contact timeline.' }
}

/** The other direction of "unsubscribe is authoritative in Rawr": a choice made
 *  here reaches Brevo's blocklist, so nobody opted out in the CRM is mailed by a
 *  campaign. Fails into the dead letter, never into the person's screen. */
export const propagateSubscriptionToBrevo = async (
  ctx: WorkspaceContext,
  input: { contactId: string; state: 'subscribed' | 'unsubscribed' | 'unspecified' },
): Promise<void> => {
  if (input.state === 'unspecified' || devIntegrationsEnabled) return
  const found = await readCredentials(ctx, 'brevo')
  if (!found?.secret) return
  const record = await getRecord(ctx, 'contact', input.contactId)
  const email = typeof record?.values.email === 'string' ? record.values.email : ''
  if (!email) return

  await attempt(
    { ctx, kind: 'brevo', jobName: 'brevo.blocklist', payload: { contactId: input.contactId, state: input.state } },
    () =>
      json<null>({
        url: `${API}/contacts/${encodeURIComponent(email)}?identifierType=email_id`,
        method: 'PUT',
        headers: headers(found.secret as string),
        body: { emailBlacklisted: input.state === 'unsubscribed' },
      }),
  )
}
