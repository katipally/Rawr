import { publicEdgeContext, recordDeadLetter, type Attribution, type AccountContext } from '@rawr/db'
import { publicBaseUrl } from '~/lib/env.ts'
import { inBackground } from './background.ts'
import { postToSlack, type SlackBody } from './integrations/slack.ts'

/** Replaces what HubSpot posts to #sales-leads-2026 today. Trevor flagged this
 *  loss first: a form fill from a real prospect lands in Slack, and that stops at
 *  cutover.
 *
 *  The lead is already saved by the time this runs. Every failure lands in
 *  dead_letter carrying the message it could not send, which is what makes the
 *  replay button on the failed-jobs screen able to send it later. None of it can
 *  fail the capture. F3 §6, F6 §5. */

export type SlackNotification = {
  accountId: string
  /** Carried so the Slack deep link opens the record in the right account.
   *  A CRM link addresses its tenant in the path, and a link that cannot is a
   *  link nobody can follow. */
  accountSlug: string
  formId: string
  submissionId: string
  formName: string
  contactId: string
  values: Record<string, unknown>
  attribution: Attribution
  channel?: string | null
}

/** Not awaited by the route, so the visitor's response is never waiting on Slack,
 *  and registered with the runtime so the post still completes after that response
 *  is written. Failures are recorded rather than thrown, because there is nobody
 *  left to throw to. */
export const queueSlackNotification = (notification: SlackNotification): void => {
  inBackground(`slack notification for submission ${notification.submissionId}`, () =>
    deliver(notification),
  )
}

const deliver = async (notification: SlackNotification): Promise<void> => {
  const ctx = publicEdgeContext(notification.accountId)
  const body = message(notification)
  // Keyed on the submission, so a retry, a replay, or both announce the lead once.
  const key = `slack:submission:${notification.submissionId}`

  await send(ctx, {
    key,
    jobName: 'slack.form-submission',
    body,
    payload: {
      submissionId: notification.submissionId,
      formId: notification.formId,
      contactId: notification.contactId,
      body,
    },
  })
}

type Outbound = {
  key: string
  jobName: string
  body: SlackBody
  payload: Record<string, unknown>
}

/** The one path everything Slack-shaped goes through. Retry, backoff, jitter and
 *  the dead letter all live in the integration layer; what is here is the decision
 *  to swallow rather than throw, because every caller is fire-and-forget. */
const send = async (ctx: AccountContext, outbound: Outbound): Promise<void> => {
  try {
    await postToSlack(ctx, outbound)
  } catch (cause) {
    // postToSlack dead-letters through the provider layer on the way out, but an
    // unconnected Slack throws before reaching it, so this catches the rest.
    await deadLetter(ctx, outbound, cause instanceof Error ? cause.message : String(cause))
  }
}

/** One meeting that has no conference link, addressed to the people who can do
 *  something about it. F2 §4 step 5: the booking stands, the host is told. */
export const queueHostAlert = (alert: {
  accountId: string
  jobName: string
  idempotencyKey: string
  payload: Record<string, unknown>
  text: string
  channel?: string | null
}): void => {
  const body: SlackBody = {
    ...(alert.channel ? { channel: alert.channel } : {}),
    text: alert.text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: alert.text } }],
  }
  inBackground(alert.idempotencyKey, () =>
    send(publicEdgeContext(alert.accountId), {
      key: alert.idempotencyKey,
      jobName: alert.jobName,
      body,
      payload: { ...alert.payload, idempotencyKey: alert.idempotencyKey, body },
    }),
  )
}

const deadLetter = async (ctx: AccountContext, outbound: Outbound, error: string): Promise<void> => {
  try {
    await recordDeadLetter(ctx, {
      jobName: outbound.jobName,
      payload: outbound.payload,
      error,
      attempts: 0,
    })
  } catch {
    // The database is the last place to record this. If it is unreachable too,
    // the lead is still saved and there is nothing further to do here.
  }
}

const message = (notification: SlackNotification): SlackBody => {
  const { values, attribution } = notification
  const answer = (...keys: string[]): string => {
    for (const key of keys) {
      const value = values[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (Array.isArray(value) && value.length) return value.join(', ')
    }
    return '—'
  }

  const name = [answer('first_name', 'firstname'), answer('last_name', 'lastname')]
    .filter((part) => part !== '—')
    .join(' ')
  const link = `${publicBaseUrl}/contacts/${notification.accountSlug}/record/contact/${notification.contactId}`

  const lines = [
    `*${notification.formName}*`,
    `${name || 'No name given'} · ${answer('email')}`,
    answer('company') !== '—' ? `Company: ${answer('company')}` : null,
    `Source: ${attribution.utm.campaign ?? attribution.utm.source ?? attribution.referrer ?? 'Direct'}`,
    attribution.pagePath ? `Page: ${attribution.pagePath}` : null,
    `<${link}|Open in Rawr>`,
  ].filter(Boolean)

  return {
    ...(notification.channel ? { channel: notification.channel } : {}),
    text: `New lead: ${name || answer('email')} via ${notification.formName}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
  }
}

/** F6 §5's second use: a deal moving stage, opt-in per pipeline. */
export const queueStageAlert = (alert: {
  accountId: string
  accountSlug: string
  dealId: string
  dealName: string
  from: string
  to: string
  actor: string
  activityId: string
}): void => {
  const link = `${publicBaseUrl}/contacts/${alert.accountSlug}/record/deal/${alert.dealId}`
  const text = `${alert.actor} moved ${alert.dealName} from ${alert.from} to ${alert.to}`
  queueHostAlert({
    accountId: alert.accountId,
    jobName: 'slack.stage-change',
    // Keyed on the activity: one move, one announcement, however many retries.
    idempotencyKey: `slack:stage:${alert.activityId}`,
    payload: { dealId: alert.dealId, activityId: alert.activityId },
    text: `${text}\n<${link}|Open in Rawr>`,
  })
}
