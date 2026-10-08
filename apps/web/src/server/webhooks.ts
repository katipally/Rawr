import {
  endpointsFor,
  eventNameFor,
  getRecord,
  systemContext,
  recordDeadLetter,
  type AccountContext,
} from '@rawr/db'
import { inBackground } from './background.ts'
import { deliverWebhook, WEBHOOK_JOB, type WebhookJob } from './webhook-delivery.ts'

/** What a subscriber is told. The record itself, not a diff: a receiver that has
 *  to reassemble state from a sequence of deltas has to receive every one of them
 *  in order, and nothing over HTTP promises that. */
const buildDelivery = async (
  ctx: AccountContext,
  input: { event: string; objectKey: string; entityId: string; accountSlug: string },
): Promise<WebhookJob[]> => {
  const endpoints = await endpointsFor(ctx, input.event)
  if (endpoints.length === 0) return []

  const record = await getRecord(ctx, input.objectKey, input.entityId)
  const body = JSON.stringify({
    event: input.event,
    at: new Date().toISOString(),
    account: input.accountSlug,
    object: input.objectKey,
    id: input.entityId,
    // Null when the record was deleted between the event and the send. Said
    // explicitly rather than omitted, so a receiver can tell "gone" from "a field
    // we forgot to include".
    record: record ? { id: record.id, displayName: record.displayName, values: record.values } : null,
  })

  return endpoints.map((endpoint) => ({
    accountId: ctx.accountId,
    endpointId: endpoint.id,
    url: endpoint.url,
    secret: endpoint.secret,
    event: input.event,
    body,
  }))
}

/** Tell everything subscribed to this event. Never awaited by a request: a slow
 *  receiver must not make the write that triggered it feel slow, and one that is
 *  down must not fail that write at all. A failed send is a dead letter, one per
 *  receiver, so the Failed jobs screen can replay it. */
export const notifySubscribers = (
  ctx: AccountContext,
  input: { objectKey: string; trigger: string; entityId: string; accountSlug: string },
): void => {
  const event = eventNameFor(input.objectKey, input.trigger)
  inBackground(`webhooks for ${event}`, async () => {
    for (const job of await buildDelivery(ctx, { ...input, event })) {
      const delivery = await deliverWebhook(job)
      if (delivery.ok) continue
      await recordDeadLetter(systemContext(job.accountId), {
        jobName: WEBHOOK_JOB,
        payload: { endpointId: job.endpointId, url: job.url, event: job.event, body: job.body },
        error: delivery.reason,
        attempts: 1,
      }).catch(() => {
        // The database is the last place to record this. Nothing above is waiting.
      })
    }
  })
}
