import {
  assertCanWrite,
  getRecord,
  ingestMarketingEvent,
  listSubscriptionTypes,
  once,
  readCredentials,
  readSegmentContactPage,
  recordHealth,
  type MarketingEvent,
  type AccountContext,
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

type BrevoConfig = { listId?: number; segmentId?: string; webhookToken?: string; subscriptionType?: string }

const credentials = async (ctx: AccountContext) => {
  const found = await readCredentials(ctx, 'brevo')
  if (!found?.secret) {
    throw new Error('Brevo is not connected. Add an API key in Settings, under Integrations.')
  }
  return { ...found, config: found.config as BrevoConfig }
}

const headers = (key: string) => ({ 'api-key': key })

export const testBrevo = async (ctx: AccountContext): Promise<ConnectionTest> => {
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

/** How many people go into one import call. Brevo caps the body at 10 MB and
 *  five hundred contacts is around eighty kilobytes of it, so the limit that
 *  binds is the page read, not the request. */
const PUSH_PAGE = 500

/** Pushes a Rawr segment into a Brevo list.
 *
 *  Three properties this must have and does: nobody who has opted out is ever
 *  included, running it twice pushes each contact once, and it pushes the whole
 *  segment. The third is new. This used to read the first two hundred members and
 *  report that number as though it were the segment, so a newsletter written for
 *  eighteen hundred people reached two hundred of them and said it had worked.
 *
 *  One import call per page rather than one create call per contact. Eighteen
 *  hundred people is four requests instead of eighteen hundred, which is the
 *  difference between a push that finishes inside the request and one that times
 *  out halfway through a list. F6 §1 and §2. */
export const pushSegmentToBrevo = async (
  ctx: AccountContext,
  input: { segmentId: string; listId?: number | null },
): Promise<PushResult> => {
  assertCanWrite(ctx, 'segment')
  const { secret, config, id } = await credentials(ctx).catch((cause) => {
    if (devIntegrationsEnabled) return { secret: null, config: {} as BrevoConfig, id: null }
    throw cause
  })
  // The list the integration was configured with, unless this push names another.
  // Resolved once here rather than at the return, where it was only ever cosmetic.
  const listId = input.listId ?? config.listId ?? null
  if (listId === null) {
    throw new Error(
      'No Brevo list to push into. Give one here, or set a list id on the Brevo integration.',
    )
  }

  let cursor: string | null = null
  let pushed = 0
  let skipped = 0

  do {
    const page = await readSegmentContactPage(ctx, input.segmentId, { after: cursor, limit: PUSH_PAGE })
    cursor = page.nextCursor

    // Narrowed rather than filtered, so the address below is a string and not a
    // string that is probably there.
    const mailable = page.rows.flatMap((row) =>
      row.mailable && row.email ? [{ ...row, email: row.email }] : [],
    )
    skipped += page.rows.length - mailable.length
    if (mailable.length === 0) continue

    // Derived from what is being sent, never random: a retry produces the same key
    // and the second attempt returns the first one's answer. Per page now, because
    // the whole set is no longer in hand at once. The rows arrive ordered by id,
    // so the same page always hashes the same way.
    const key = `brevo:list:${listId}:${createHash('sha256')
      .update(mailable.map((row) => row.id).join(','))
      .digest('hex')
      .slice(0, 32)}`

    await once(ctx, { key, operation: 'brevo.push_list', integrationId: id }, async () => {
      if (devIntegrationsEnabled) return { pushed: mailable.length, processId: null }
      const accepted = await attempt(
        {
          ctx,
          kind: 'brevo',
          jobName: 'brevo.import_contacts',
          payload: { segmentId: input.segmentId, listId, count: mailable.length },
        },
        () =>
          json<{ processId?: number }>({
            url: `${API}/contacts/import`,
            method: 'POST',
            headers: headers(secret!),
            body: {
              listIds: [listId],
              // The upsert. Without it a second push is an error per existing
              // contact rather than a no-op.
              updateExistingContacts: true,
              // A blank first name here means "we do not know it", never "delete
              // the one Brevo has". This is Brevo's default and is passed anyway,
              // because the failure it prevents is silent and permanent.
              emptyContactsAttributes: false,
              jsonBody: mailable.map((row) => ({
                email: row.email,
                attributes: { FIRSTNAME: row.firstName ?? '', LASTNAME: row.lastName ?? '' },
              })),
            },
            // The import is accepted, not performed, inside this call; Brevo
            // answers 202 with a process id. Still worth more than the default
            // fifteen seconds, because the body carries five hundred people.
            timeoutMs: 60_000,
          }),
      )
      return { pushed: mailable.length, processId: accepted?.processId ?? null }
    })

    pushed += mailable.length
  } while (cursor)

  await recordHealth(ctx, 'brevo', { ok: true })
  return { pushed, skipped, listId }
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

/** Brevo's payload as a Rawr event, or the reason it is not one. Pure, so the
 *  vocabulary above can be tested without a database. */
export const parseBrevoEvent = (body: unknown): { ok: true; event: MarketingEvent } | { ok: false; detail: string } => {
  const event = body as BrevoWebhook
  const kind = EVENT_MAP[event.event ?? '']
  if (!kind) return { ok: false, detail: `Brevo event "${event.event}" is not one Rawr records.` }
  if (!event.email) return { ok: false, detail: 'That event carried no address.' }
  return {
    ok: true,
    event: {
      source: 'brevo',
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
    },
  }
}

export const handleBrevoWebhook = async (
  ctx: AccountContext,
  body: unknown,
): Promise<{ handled: boolean; detail: string }> => {
  const parsed = parseBrevoEvent(body)
  if (!parsed.ok) return { handled: false, detail: parsed.detail }

  const { config } = await credentials(ctx)
  const outcome = await ingestMarketingEvent(ctx, {
    ...parsed.event,
    ...(config.subscriptionType ? { subscriptionTypes: [config.subscriptionType] } : {}),
  })

  await recordHealth(ctx, 'brevo', { ok: true })
  return { handled: outcome.stored, detail: outcome.reason ?? 'Recorded on the contact timeline.' }
}

/** The other direction of "unsubscribe is authoritative in Rawr": a choice made
 *  here reaches Brevo's blocklist, so nobody opted out in the CRM is mailed by a
 *  campaign. Fails into the dead letter, never into the person's screen. */
export const propagateSubscriptionToBrevo = async (
  ctx: AccountContext,
  input: { contactId: string; typeId: string; state: 'subscribed' | 'unsubscribed' | 'unspecified' },
): Promise<void> => {
  if (input.state === 'unspecified' || devIntegrationsEnabled) return
  const found = await readCredentials(ctx, 'brevo')
  if (!found?.secret) return
  // Only the type Brevo is mapped to, when one is named: opting out of sales
  // one-to-ones is not a reason to block the newsletter, or the reverse.
  const mapped = (found.config as BrevoConfig).subscriptionType?.trim().toLowerCase()
  if (mapped) {
    const type = (await listSubscriptionTypes(ctx)).find((row) => row.id === input.typeId)
    if (!type || type.name.toLowerCase() !== mapped) return
  }
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

/* -- B12: the campaign, aimed and measured from here ----------------------- */

export type BrevoTemplate = { id: number; name: string; subject: string | null; isActive: boolean }

/** Brevo's own template gallery, so a compose step picks a design rather than
 *  editing one. `/v3/smtp/templates` is documented as the transactional list; a
 *  campaign's `templateId` says "existing active templates". If a account's
 *  campaign designs turn out not to be in this list, the compose step still works
 *  by naming a template id, which is why the id is shown beside every name. */
export const listBrevoTemplates = async (ctx: AccountContext): Promise<BrevoTemplate[]> => {
  if (devIntegrationsEnabled) {
    return [{ id: 1, name: 'Development template', subject: 'A newsletter', isActive: true }]
  }
  const { secret } = await credentials(ctx)
  const answer = await json<{
    templates?: { id: number; name: string; subject?: string; isActive?: boolean }[]
  }>({ url: `${API}/smtp/templates?limit=100&sort=desc`, headers: headers(secret!) })
  return (answer.templates ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    subject: row.subject ?? null,
    isActive: row.isActive !== false,
  }))
}

export type BrevoCampaign = {
  id: number
  name: string
  subject: string | null
  status: string
  sentAt: string | null
  /** Null until Brevo has something to report, which is not the same as zero. */
  stats: {
    sent: number
    delivered: number
    opens: number
    uniqueOpens: number
    clicks: number
    uniqueClicks: number
    bounces: number
    unsubscribes: number
    complaints: number
  } | null
}

type BrevoStats = {
  sent?: number
  delivered?: number
  viewed?: number
  uniqueViews?: number
  clickers?: number
  uniqueClicks?: number
  hardBounces?: number
  softBounces?: number
  unsubscriptions?: number
  complaints?: number
}

const statsOf = (global: BrevoStats | undefined): BrevoCampaign['stats'] =>
  global
    ? {
        sent: global.sent ?? 0,
        delivered: global.delivered ?? 0,
        opens: global.viewed ?? 0,
        uniqueOpens: global.uniqueViews ?? 0,
        clicks: global.clickers ?? 0,
        uniqueClicks: global.uniqueClicks ?? 0,
        // One number, because a hard bounce and a soft one are the same fact to
        // somebody deciding whether the list has gone stale.
        bounces: (global.hardBounces ?? 0) + (global.softBounces ?? 0),
        unsubscribes: global.unsubscriptions ?? 0,
        complaints: global.complaints ?? 0,
      }
    : null

export const listBrevoCampaigns = async (ctx: AccountContext): Promise<BrevoCampaign[]> => {
  if (devIntegrationsEnabled) return []
  const { secret } = await credentials(ctx)
  const answer = await json<{
    campaigns?: {
      id: number
      name: string
      subject?: string
      status: string
      sentDate?: string
      statistics?: { globalStats?: BrevoStats }
    }[]
  }>({
    url: `${API}/emailCampaigns?limit=50&sort=desc&statistics=globalStats`,
    headers: headers(secret!),
    timeoutMs: 30_000,
  })
  return (answer.campaigns ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    subject: row.subject ?? null,
    status: row.status,
    sentAt: row.sentDate ?? null,
    stats: statsOf(row.statistics?.globalStats),
  }))
}

export type ScheduleInput = {
  segmentId: string
  listId: number
  name: string
  subject: string
  senderName: string
  senderEmail: string
  templateId: number
  /** ISO. Absent leaves the campaign a draft, to be sent by hand. */
  scheduledAt?: string | null
}

/** Push the audience, then create the campaign against the list it went into.
 *
 *  In that order and never the reverse: a campaign created first would be aimed
 *  at whatever the list held before this push, which is the previous send's
 *  audience. The push is the same idempotent walk `pushSegmentToBrevo` does, so
 *  running this twice does not double the list. */
export const scheduleBrevoCampaign = async (
  ctx: AccountContext,
  input: ScheduleInput,
): Promise<{ campaignId: number | null; pushed: number; skipped: number }> => {
  assertCanWrite(ctx, 'segment')
  const push = await pushSegmentToBrevo(ctx, { segmentId: input.segmentId, listId: input.listId })
  if (push.pushed === 0) {
    throw new Error('Nobody in that segment can be mailed, so there is nothing to send to.')
  }

  if (devIntegrationsEnabled) return { campaignId: null, ...push }

  const { secret, id } = await credentials(ctx)
  const key = `brevo:campaign:${input.listId}:${createHash('sha256')
    .update(`${input.name} ${input.subject} ${input.templateId} ${input.scheduledAt ?? 'draft'}`)
    .digest('hex')
    .slice(0, 32)}`

  const outcome = await once(ctx, { key, operation: 'brevo.create_campaign', integrationId: id }, () =>
    attempt(
      { ctx, kind: 'brevo', jobName: 'brevo.create_campaign', payload: { listId: input.listId, name: input.name } },
      () =>
        json<{ id?: number }>({
          url: `${API}/emailCampaigns`,
          method: 'POST',
          headers: headers(secret!),
          body: {
            name: input.name,
            subject: input.subject,
            sender: { name: input.senderName, email: input.senderEmail },
            templateId: input.templateId,
            recipients: { listIds: [input.listId] },
            ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
          },
          timeoutMs: 30_000,
        }),
    ),
  )

  return { campaignId: (outcome.response as { id?: number } | null)?.id ?? null, ...push }
}

/** Send a campaign that is already a draft in Brevo. Separate from creating one
 *  on purpose: "write it" and "send it to eighteen hundred people" are different
 *  decisions and belong behind different buttons. */
export const sendBrevoCampaign = async (ctx: AccountContext, campaignId: number): Promise<void> => {
  assertCanWrite(ctx, 'segment')
  if (devIntegrationsEnabled) return
  const { secret, id } = await credentials(ctx)
  await once(ctx, { key: `brevo:send:${campaignId}`, operation: 'brevo.send_campaign', integrationId: id }, () =>
    attempt({ ctx, kind: 'brevo', jobName: 'brevo.send_campaign', payload: { campaignId } }, () =>
      json<null>({
        url: `${API}/emailCampaigns/${campaignId}/sendNow`,
        method: 'POST',
        headers: headers(secret!),
        timeoutMs: 30_000,
      }),
    ),
  )
}
