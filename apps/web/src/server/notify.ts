import { publicEdgeContext, recordDeadLetter, type Attribution } from '@rawr/db'
import { env, publicBaseUrl, slackConfigured } from '~/lib/env.ts'

/** Replaces what HubSpot posts to #sales-leads-2026 today. Trevor flagged this
 *  loss first: a form fill from a real prospect lands in Slack, and that stops at
 *  cutover.
 *
 *  The lead is already saved by the time this runs. Every failure lands in
 *  dead_letter with the real error and is replayable; none of them can fail the
 *  capture. F3 §6. */

export type SlackNotification = {
  workspaceId: string
  /** Carried so the Slack deep link opens the record in the right workspace.
   *  A CRM link addresses its tenant in the path, and a link that cannot is a
   *  link nobody can follow. */
  workspaceSlug: string
  formId: string
  submissionId: string
  formName: string
  contactId: string
  values: Record<string, unknown>
  attribution: Attribution
  channel?: string | null
}

const ATTEMPTS = 3

/** Fired and not awaited by the route, so the visitor's response is never waiting
 *  on Slack. Failures are recorded rather than thrown, because there is nobody
 *  left to throw to. */
export const queueSlackNotification = (notification: SlackNotification): void => {
  void deliver(notification).catch(() => {
    // deliver() already dead-letters. This catch exists so an unhandled rejection
    // cannot take the process down on a bad day.
  })
}

const deliver = (notification: SlackNotification): Promise<void> =>
  send({
    workspaceId: notification.workspaceId,
    jobName: 'slack.form-submission',
    payload: {
      submissionId: notification.submissionId,
      formId: notification.formId,
      contactId: notification.contactId,
      channel: notification.channel ?? null,
    },
    body: message(notification),
  })

/** One meeting that has no conference link, addressed to the people who can do
 *  something about it. F2 §4 step 5: the booking stands, the host is told. */
export const queueHostAlert = (alert: {
  workspaceId: string
  jobName: string
  payload: Record<string, unknown>
  text: string
  channel?: string | null
}): void => {
  void send({
    workspaceId: alert.workspaceId,
    jobName: alert.jobName,
    payload: alert.payload,
    body: {
      ...(env.SLACK_BOT_TOKEN ? { channel: alert.channel ?? env.SLACK_DEFAULT_CHANNEL } : {}),
      text: alert.text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: alert.text } }],
    },
  }).catch(() => {
    // send() already dead-letters.
  })
}

type Outbound = {
  workspaceId: string
  jobName: string
  payload: Record<string, unknown>
  body: SlackBody
}

const send = async (outbound: Outbound): Promise<void> => {
  if (!slackConfigured) {
    await deadLetter(
      outbound,
      'Slack is not configured. Set SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL (open item 4).',
      0,
    )
    return
  }

  let lastError = 'unknown'
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const outcome = await post(outbound.body)
      if (outcome === null) return
      lastError = outcome
      // Backoff with jitter, so a Slack blip does not turn into a thundering herd
      // when many forms are submitted in the same minute.
      const base = 2 ** (attempt - 1) * 500
      await sleep(base + Math.random() * base)
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause)
    }
  }
  await deadLetter(outbound, lastError, ATTEMPTS)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type SlackBody = { channel?: string | undefined; text: string; blocks: unknown[] }

/** Returns null on success, or the error to retry on. */
const post = async (payload: SlackBody): Promise<string | null> => {
  const body = JSON.stringify(payload)
  const target = env.SLACK_BOT_TOKEN
    ? 'https://slack.com/api/chat.postMessage'
    : env.SLACK_WEBHOOK_URL

  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(env.SLACK_BOT_TOKEN ? { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } : {}),
    },
    body,
    signal: AbortSignal.timeout(8000),
  })

  if (!response.ok) return `Slack answered ${response.status} ${response.statusText}.`

  // A webhook answers "ok" as plain text; the Web API answers JSON and reports
  // failure inside a 200, which is the case a status check alone would miss.
  if (!env.SLACK_BOT_TOKEN) return null
  const result = (await response.json()) as { ok?: boolean; error?: string }
  if (result.ok) return null
  return `Slack refused the message: ${result.error ?? 'unknown error'}.`
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
  const link = `${publicBaseUrl}/contacts/${notification.workspaceSlug}/record/contact/${notification.contactId}`

  const lines = [
    `*${notification.formName}*`,
    `${name || 'No name given'} · ${answer('email')}`,
    answer('company') !== '—' ? `Company: ${answer('company')}` : null,
    `Source: ${attribution.utm.campaign ?? attribution.utm.source ?? attribution.referrer ?? 'Direct'}`,
    attribution.pagePath ? `Page: ${attribution.pagePath}` : null,
    `<${link}|Open in Rawr>`,
  ].filter(Boolean)

  return {
    ...(env.SLACK_BOT_TOKEN
      ? { channel: notification.channel ?? env.SLACK_DEFAULT_CHANNEL }
      : {}),
    text: `New lead: ${name || answer('email')} via ${notification.formName}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
  }
}

const deadLetter = async (outbound: Outbound, error: string, attempts: number): Promise<void> => {
  try {
    await recordDeadLetter(publicEdgeContext(outbound.workspaceId), {
      jobName: outbound.jobName,
      payload: outbound.payload,
      error,
      attempts,
    })
  } catch {
    // The database is the last place to record this. If it is unreachable too,
    // the lead is still saved and there is nothing further to do here.
  }
}
