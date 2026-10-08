import { createHmac } from 'node:crypto'
import { recordDelivery, systemContext } from '@rawr/db'
import { hostOf, outboundRequest } from './outbound.ts'

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
  accountId: string
  endpointId: string
  url: string
  secret: string
  event: string
  body: string
}

export const WEBHOOK_JOB = 'webhook.deliver'

export type Delivery = { ok: true } | { ok: false; reason: string }

/** A plain sentence the Failed jobs screen can show as it is. Redirects are named
 *  because a receiver that moved is the usual cause, and Rawr never follows one. */
const statusReason = (url: string, status: number): string =>
  status >= 300 && status < 400
    ? `${hostOf(url)} answered ${status} with a redirect, which Rawr does not follow.`
    : `${hostOf(url)} answered ${status}.`

/** One POST and the health line it leaves behind. Returns what happened rather than
 *  recording a dead letter, because the caller decides what a failure means: a
 *  scheduled send opens a new failure, a replay leaves the existing one open.
 *
 *  Never throws. The caller is a background task with nobody waiting on it, and a
 *  webhook that cannot be delivered must never turn into a failed write for the
 *  person who triggered it.
 *
 *  The endpoint's own health is written either way, because "this one has been
 *  failing for two days" is the question a subscriber's owner actually has, and a
 *  dead letter in an admin's list does not answer it. */
export const deliverWebhook = async (job: WebhookJob): Promise<Delivery> => {
  const ctx = systemContext(job.accountId)
  const fail = async (status: number | null, reason: string): Promise<Delivery> => {
    await recordDelivery(ctx, job.endpointId, { ok: false, status, error: reason }).catch(() => {})
    return { ok: false, reason }
  }

  let response: Awaited<ReturnType<typeof outboundRequest>>
  try {
    response = await outboundRequest({
      url: job.url,
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
      timeoutMs: 15_000,
      // Only the status is read; a receiver that answers with a page is not failing.
      maxBytes: 16_384,
    })
  } catch (cause) {
    // Every error outboundRequest throws is a sentence it wrote, host included.
    return fail(null, cause instanceof Error ? cause.message : `${hostOf(job.url)} could not be reached.`)
  }

  if (!response.ok) return fail(response.status, statusReason(job.url, response.status))
  await recordDelivery(ctx, job.endpointId, { ok: true, status: response.status }).catch(() => {})
  return { ok: true }
}
