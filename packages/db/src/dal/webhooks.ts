import { asc, eq } from 'drizzle-orm'
import { webhookEndpoint } from '../schema/platform.ts'
import type { ObjectKey } from '../registry/core.ts'
import { randomToken } from '../internal/crypto.ts'
import type { WorkspaceContext } from './context.ts'
import { mutate, withWorkspace } from './index.ts'

/** Who is subscribed to what happens in Rawr, and the key that proves a delivery
 *  came from us.
 *
 *  The delivery itself is not here. It is a pg-boss job like every other, which
 *  is the whole point: the retries, the exponential backoff and the landing in
 *  `dead_letter` on a final failure are the ones the worker already gives every
 *  job, and a failed delivery replays from the Failed jobs screen that already
 *  exists. Writing a delivery queue here would be a second copy of all of it. */

/** The events something can subscribe to.
 *
 *  Deliberately the same four things an automation triggers on, named per object,
 *  because they are the same events: one vocabulary in the product rather than a
 *  second list that drifts from the first. Adding an event is adding it to both,
 *  which is the reminder that it has to be emitted somewhere. */
export const WEBHOOK_EVENTS = [
  'contact.created',
  'company.created',
  'deal.created',
  'deal.stage_changed',
  'contact.lifecycle_changed',
  'company.lifecycle_changed',
  'contact.form_submitted',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/** The name an event carries on the wire, from the pair that already describes
 *  it everywhere else. Not every pair is a real event, so this can return one
 *  nothing subscribes to, and nothing subscribing to it is the correct outcome. */
export const eventNameFor = (objectKey: ObjectKey, trigger: string): string =>
  `${objectKey}.${trigger === 'record_created' ? 'created' : trigger}`

export type WebhookEndpointRow = {
  id: string
  name: string
  url: string
  events: string[]
  isActive: boolean
  lastOkAt: Date | null
  lastStatus: number | null
  lastError: string | null
  lastErrorAt: Date | null
  createdAt: Date
}

const SELECT = {
  id: webhookEndpoint.id,
  name: webhookEndpoint.name,
  url: webhookEndpoint.url,
  events: webhookEndpoint.events,
  isActive: webhookEndpoint.isActive,
  lastOkAt: webhookEndpoint.lastOkAt,
  lastStatus: webhookEndpoint.lastStatus,
  lastError: webhookEndpoint.lastError,
  lastErrorAt: webhookEndpoint.lastErrorAt,
  createdAt: webhookEndpoint.createdAt,
}

const shape = (row: Record<string, unknown>): WebhookEndpointRow => ({
  id: String(row.id),
  name: String(row.name),
  url: String(row.url),
  events: Array.isArray(row.events) ? (row.events as string[]) : [],
  isActive: row.isActive === true,
  lastOkAt: row.lastOkAt ? new Date(String(row.lastOkAt)) : null,
  lastStatus: row.lastStatus === null || row.lastStatus === undefined ? null : Number(row.lastStatus),
  lastError: (row.lastError as string | null) ?? null,
  lastErrorAt: row.lastErrorAt ? new Date(String(row.lastErrorAt)) : null,
  createdAt: new Date(String(row.createdAt)),
})

/** https, and a host that resolves outside this machine.
 *
 *  A signature says a payload came from us; it says nothing about who read it on
 *  the way, so plaintext is refused. Loopback and the private ranges are refused
 *  because an endpoint pointing at the network Rawr itself runs on turns "add a
 *  webhook" into a request forgery any admin can aim wherever they like — at a
 *  cloud metadata service, most of all.
 *
 *  Both rules lift outside production, and only there, because the alternative is
 *  that a webhook cannot be developed against at all: the first receiver anybody
 *  writes runs on their own laptop. `NODE_ENV` is what separates them, the same
 *  switch the stand-in providers use. */
const PRIVATE_HOST =
  /^(localhost$|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?fc|\[?fd)/i

const checkUrl = (raw: string): string => {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new Error(`"${raw}" is not a URL.`)
  }
  const local = process.env.NODE_ENV !== 'production'
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new Error('A webhook endpoint has to be https. A record on the wire in plaintext is readable by anyone on the path.')
  }
  if (PRIVATE_HOST.test(parsed.hostname) && !local) {
    throw new Error(`${parsed.hostname} is on a private network. An endpoint has to be somewhere Rawr can reach from the outside.`)
  }
  return parsed.toString()
}

const checkEvents = (events: string[]): string[] => {
  const unknown = events.filter((event) => !(WEBHOOK_EVENTS as readonly string[]).includes(event))
  if (unknown.length > 0) throw new Error(`Rawr does not send ${unknown.join(', ')}.`)
  return [...new Set(events)]
}

export const listWebhookEndpoints = async (ctx: WorkspaceContext): Promise<WebhookEndpointRow[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx.select(SELECT).from(webhookEndpoint).orderBy(asc(webhookEndpoint.createdAt))
    return rows.map(shape)
  })

/** Every live endpoint that wants this event. An empty `events` means all of
 *  them, so a subscriber piping everything into a warehouse does not have to come
 *  back and edit a list each time an event is added. */
export const endpointsFor = async (
  ctx: WorkspaceContext,
  event: string,
): Promise<{ id: string; url: string; secret: string }[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx
      .select({ id: webhookEndpoint.id, url: webhookEndpoint.url, secret: webhookEndpoint.secret, events: webhookEndpoint.events })
      .from(webhookEndpoint)
      .where(eq(webhookEndpoint.isActive, true))
    return rows
      .filter((row) => {
        const wanted = Array.isArray(row.events) ? (row.events as string[]) : []
        return wanted.length === 0 || wanted.includes(event)
      })
      .map(({ id, url, secret }) => ({ id, url, secret }))
  })

export type IssuedEndpoint = { id: string; secret: string }

/** The secret comes back exactly once, here, the way an agent token's does. */
export const createWebhookEndpoint = async (
  ctx: WorkspaceContext,
  input: { name: string; url: string; events: string[] },
): Promise<IssuedEndpoint> =>
  mutate(ctx, 'webhook_endpoint', async (tx) => {
    const name = input.name.trim()
    if (!name) throw new Error('Give the endpoint a name, so the right one can be turned off later.')
    const url = checkUrl(input.url)
    const events = checkEvents(input.events)
    const secret = `whsec_${randomToken(32)}`

    const [created] = await tx
      .insert(webhookEndpoint)
      .values({ workspaceId: ctx.workspaceId, createdBy: ctx.actorId, name, url, secret, events })
      .returning({ id: webhookEndpoint.id })
    if (!created) throw new Error('The endpoint could not be created.')
    return {
      result: { id: created.id, secret },
      // The secret is not in the audit row. History is readable by every admin,
      // and a signing key in it would outlive any decision to roll it.
      audit: { entity: 'webhook_endpoint', entityId: created.id, action: 'create', before: null, after: { name, url, events } },
    }
  })

export const updateWebhookEndpoint = async (
  ctx: WorkspaceContext,
  id: string,
  input: {
    name?: string | undefined
    url?: string | undefined
    events?: string[] | undefined
    isActive?: boolean | undefined
  },
): Promise<void> =>
  mutate(ctx, 'webhook_endpoint', async (tx) => {
    const [before] = await tx.select(SELECT).from(webhookEndpoint).where(eq(webhookEndpoint.id, id)).limit(1)
    if (!before) throw new Error('That endpoint no longer exists.')

    const values = {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.url === undefined ? {} : { url: checkUrl(input.url) }),
      ...(input.events === undefined ? {} : { events: checkEvents(input.events) }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      updatedAt: new Date(),
    }
    await tx.update(webhookEndpoint).set(values).where(eq(webhookEndpoint.id, id))
    return {
      result: undefined,
      audit: { entity: 'webhook_endpoint', entityId: id, action: 'update', before, after: values },
    }
  })

/** A new key, returned once. The old one stops working the moment this commits,
 *  which is the point: a rolled key is only rolled if the old one is dead. */
export const rollWebhookSecret = async (ctx: WorkspaceContext, id: string): Promise<string> =>
  mutate(ctx, 'webhook_endpoint', async (tx) => {
    const [before] = await tx
      .select({ name: webhookEndpoint.name })
      .from(webhookEndpoint)
      .where(eq(webhookEndpoint.id, id))
      .limit(1)
    if (!before) throw new Error('That endpoint no longer exists.')
    const secret = `whsec_${randomToken(32)}`
    await tx.update(webhookEndpoint).set({ secret, updatedAt: new Date() }).where(eq(webhookEndpoint.id, id))
    return {
      result: secret,
      audit: { entity: 'webhook_endpoint', entityId: id, action: 'roll_secret', before: null, after: { name: before.name } },
    }
  })

export const removeWebhookEndpoint = async (ctx: WorkspaceContext, id: string): Promise<void> =>
  mutate(ctx, 'webhook_endpoint', async (tx) => {
    const [before] = await tx.select(SELECT).from(webhookEndpoint).where(eq(webhookEndpoint.id, id)).limit(1)
    if (!before) throw new Error('That endpoint no longer exists.')
    await tx.delete(webhookEndpoint).where(eq(webhookEndpoint.id, id))
    return {
      result: undefined,
      audit: { entity: 'webhook_endpoint', entityId: id, action: 'delete', before, after: null },
    }
  })

/** What the last delivery did. The same four columns an integration keeps, for
 *  the same reason: a subscriber that quietly stopped receiving is the failure
 *  that matters, and it is invisible without somewhere to write the last answer.
 *
 *  Not a `mutate`: this is the worker reporting, not a person deciding, and an
 *  audit row per delivery would bury the history somebody actually reads. */
export const recordDelivery = async (
  ctx: WorkspaceContext,
  id: string,
  outcome: { ok: true; status: number } | { ok: false; status: number | null; error: string },
): Promise<void> => {
  await withWorkspace(ctx, (tx) =>
    tx
      .update(webhookEndpoint)
      .set(
        outcome.ok
          ? { lastOkAt: new Date(), lastStatus: outcome.status, lastError: null, lastErrorAt: null }
          : { lastStatus: outcome.status, lastError: outcome.error.slice(0, 500), lastErrorAt: new Date() },
      )
      .where(eq(webhookEndpoint.id, id)),
  )
}
