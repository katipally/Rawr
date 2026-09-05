import { createHmac } from 'node:crypto'
import {
  endpointsFor,
  eventNameFor,
  getRecord,
  publicEdgeContext,
  recordDeadLetter,
  recordDelivery,
  type WorkspaceContext,
} from '@rawr/db'
import { inBackground } from './background.ts'

/** Sending Rawr's own events out, and proving they came from us.
 *
 *  The shape the Slack notifications already use: attempted off the request, and
 *  a failure recorded as a dead letter rather than thrown, because by then there
 *  is nobody left to throw to. The Failed jobs screen lists it and replays it,
 *  and the replay is safe twice because a receiver is sent the record as it is
 *  rather than a diff. Nothing new was built for any of that. */

/** Seconds, not milliseconds: this is what a receiver compares against its own
 *  clock, and every other webhook signature in the world is in seconds. */
const signedAt = () => Math.floor(Date.now() / 1000)

/** `t=<unix seconds>,v1=<hex>`, over `<t>.<body>`.
 *
 *  The timestamp is inside the signed string rather than beside it, which is what
 *  lets a receiver refuse a replay: without it, a delivery captured once is valid
 *  forever and the signature only proves it was genuine at some point. The same
 *  reason Rawr enforces a replay window on the webhooks it receives. */
export const signPayload = (secret: string, body: string, at = signedAt()): string =>
  `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`

export type WebhookJob = {
  workspaceId: string
  endpointId: string
  url: string
  secret: string
  event: string
  body: string
}

/** What a subscriber is told. The record itself, not a diff: a receiver that has
 *  to reassemble state from a sequence of deltas has to receive every one of them
 *  in order, and nothing over HTTP promises that. */
export const buildDelivery = async (
  ctx: WorkspaceContext,
  input: { event: string; objectKey: string; entityId: string; workspaceSlug: string },
): Promise<WebhookJob[]> => {
  const endpoints = await endpointsFor(ctx, input.event)
  if (endpoints.length === 0) return []

  const record = await getRecord(ctx, input.objectKey, input.entityId)
  const body = JSON.stringify({
    event: input.event,
    at: new Date().toISOString(),
    workspace: input.workspaceSlug,
    object: input.objectKey,
    id: input.entityId,
    // Null when the record was deleted between the event and the send. Said
    // explicitly rather than omitted, so a receiver can tell "gone" from "a field
    // we forgot to include".
    record: record ? { id: record.id, displayName: record.displayName, values: record.values } : null,
  })

  return endpoints.map((endpoint) => ({
    workspaceId: ctx.workspaceId,
    endpointId: endpoint.id,
    url: endpoint.url,
    secret: endpoint.secret,
    event: input.event,
    body,
  }))
}

export const WEBHOOK_JOB = 'webhook.deliver'

/** One POST, the health line it leaves behind, and a dead letter if it failed.
 *
 *  Swallows rather than throws, like every other fire-and-forget sender here:
 *  the caller is a background task with nobody waiting on it, and a webhook that
 *  cannot be delivered must never turn into a failed write for the person who
 *  triggered it.
 *
 *  The endpoint's own health is written either way, because "this one has been
 *  failing for two days" is the question a subscriber's owner actually has, and a
 *  dead letter in an admin's list does not answer it. */
export const deliverWebhook = async (job: WebhookJob): Promise<void> => {
  const ctx = publicEdgeContext(job.workspaceId)
  const failed = async (status: number | null, error: string) => {
    await recordDelivery(ctx, job.endpointId, { ok: false, status, error }).catch(() => {})
    await recordDeadLetter(ctx, {
      jobName: WEBHOOK_JOB,
      payload: { endpointId: job.endpointId, url: job.url, event: job.event, body: job.body },
      error,
      attempts: 1,
    }).catch(() => {
      // The database is the last place to record this. Nothing above is waiting.
    })
  }

  try {
    const response = await fetch(job.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Rawr-Webhooks/1',
        'rawr-event': job.event,
        'rawr-signature': signPayload(job.secret, job.body),
      },
      body: job.body,
      // A receiver slower than this is one whose answer nobody is waiting for.
      // A replay is the remedy, not a longer wait holding a socket open.
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      await failed(response.status, `${job.url} answered ${response.status}.`)
      return
    }
    await recordDelivery(ctx, job.endpointId, { ok: true, status: response.status })
  } catch (cause) {
    await failed(null, describe(cause, job.url))
  }
}

/** Node's fetch reports every transport failure as "fetch failed" and puts the
 *  real reason — refused, DNS, TLS, timed out — one level down in `cause`. An
 *  admin looking at a red row needs that reason and the address it was aimed at,
 *  not two words that are true of every possible failure. */
const describe = (cause: unknown, url: string): string => {
  if (cause instanceof Error && cause.name === 'TimeoutError') return `${url} did not answer within 15 seconds.`
  const inner = cause instanceof Error ? (cause.cause as Error | undefined) : undefined
  const reason = inner?.message ?? (cause instanceof Error ? cause.message : String(cause))
  return `${url} could not be reached: ${reason}`
}

/** Tell everything subscribed to this event. Never awaited by a request: a slow
 *  receiver must not make the write that triggered it feel slow, and one that is
 *  down must not fail that write at all. */
export const notifySubscribers = (
  ctx: WorkspaceContext,
  input: { objectKey: string; trigger: string; entityId: string; workspaceSlug: string },
): void => {
  const event = eventNameFor(input.objectKey, input.trigger)
  inBackground(`webhooks for ${event}`, async () => {
    for (const job of await buildDelivery(ctx, { ...input, event })) await deliverWebhook(job)
  })
}
