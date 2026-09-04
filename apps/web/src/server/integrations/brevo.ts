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

type BrevoConfig = { listId?: number; segmentId?: string; webhookToken?: string; subscriptionType?: string }

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
  ctx: WorkspaceContext,
  input: { segmentId: string; listId: number },
): Promise<PushResult> => {
  assertCanWrite(ctx, 'segment')
  const { secret, config, id } = await credentials(ctx).catch((cause) => {
    if (devIntegrationsEnabled) return { secret: null, config: {} as BrevoConfig, id: null }
    throw cause
  })

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
    const key = `brevo:list:${input.listId}:${createHash('sha256')
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
          payload: { segmentId: input.segmentId, listId: input.listId, count: mailable.length },
        },
        () =>
          json<{ processId?: number }>({
            url: `${API}/contacts/import`,
            method: 'POST',
            headers: headers(secret!),
            body: {
              listIds: [input.listId],
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
  return { pushed, skipped, listId: input.listId ?? config.listId ?? null }
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
  ctx: WorkspaceContext,
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
  ctx: WorkspaceContext,
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
