import {
  publicEdgeContext,
  publicFormBySlug,
} from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { clientIp, rateLimit } from '~/server/edge.ts'
import { webflowSecret, webflowSignatureMatches } from '~/server/integrations/webflow.ts'
import { queueSlackNotification } from '~/server/notify.ts'
import { runSubmission } from '~/server/submit.ts'
import { reportEvent } from '~/server/automations.ts'

/** POST /w/webflow — F3 §7's fallback for native Webflow forms. Attribution is
 *  weaker than the embed's: Webflow sends no query string. An unsigned delivery is
 *  refused, because an unverified webhook is an open lead-injection endpoint. */

/** Webflow's own guidance. Older than this is a replay, not a delivery. */
const REPLAY_WINDOW_MS = 5 * 60 * 1000

/** 200 with a reason for anything unprocessable: a non-2xx makes Webflow retry. */
const accepted = (detail: string): NextResponse =>
  NextResponse.json({ ok: true, detail }, { status: 200 })

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const raw = await request.text()
  const signature = request.headers.get('x-webflow-signature')
  const timestamp = request.headers.get('x-webflow-timestamp')

  if (!signature || !timestamp) {
    return NextResponse.json(
      { error: 'Unsigned webhook. Create the webhook through an OAuth app so it is signed.' },
      { status: 401 },
    )
  }

  const age = Date.now() - Number(timestamp)
  if (!Number.isFinite(age) || age > REPLAY_WINDOW_MS || age < -REPLAY_WINDOW_MS) {
    return NextResponse.json({ error: 'That delivery is outside the replay window.' }, { status: 401 })
  }

  // Two reads happen before the signature can be checked, so cap unsigned callers.
  const ip = clientIp(request)
  if (!rateLimit(`w:webflow:${ip ?? 'unknown'}`, 60, 60).allowed) {
    return NextResponse.json({ error: 'Too many deliveries.' }, { status: 429 })
  }

  // Read before the signature: the secret that verifies it belongs to this org.
  const url = new URL(request.url)
  const account = url.searchParams.get('account')
  const slug = url.searchParams.get('form')
  if (!account || !slug) {
    return accepted('This webhook URL carries no account and form mapping, so nothing was recorded.')
  }

  const form = await publicFormBySlug(account, slug)
  if (!form || !form.isActive) return accepted('That Rawr form is not accepting submissions.')

  const secret = await webflowSecret(publicEdgeContext(form.accountId))
  if (!secret) {
    return NextResponse.json(
      { error: 'Webflow is not connected. Paste the app client secret on Settings, Integrations.' },
      { status: 503 },
    )
  }

  if (!webflowSignatureMatches(secret, timestamp, raw, signature)) {
    return NextResponse.json({ error: 'That signature does not match.' }, { status: 401 })
  }

  let payload: WebflowPayload
  try {
    payload = JSON.parse(raw) as WebflowPayload
  } catch {
    return accepted('Body was not JSON, so there is nothing to retry.')
  }

  const data = payload.payload ?? payload
  const formName = data.name ?? data.formName ?? null
  const siteId = data.siteId ?? payload.siteId ?? null
  if (!formName) return accepted('No form name in the payload.')

  const answers = data.data ?? data.formResponse ?? {}
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(answers)) {
    body[normaliseKey(key)] = Array.isArray(value) ? value.map(String) : String(value ?? '')
  }

  const result = await runSubmission(request, form, body, ip, {
    degradedSignals: true,
    // Webflow's own id, so a redelivery is a no-op rather than a second lead.
    idempotencyKey: data.id ?? data._id ?? `${siteId ?? 'webflow'}:${timestamp}`,
    attributionOverride: { pagePath: data.pageId ?? null, referrer: data.siteDomain ?? null },
  })

  if (result.errors?.length) {
    // A schema mismatch is a configuration problem; retrying it forever helps nobody.
    return accepted(
      `Not recorded: ${result.errors.map((e) => e.message).join(' ')}`,
    )
  }

  if (result.notify) {
    queueSlackNotification({
      accountId: form.accountId,
      accountSlug: form.accountSlug,
      formId: form.formId,
      submissionId: result.submissionId,
      ...result.notify,
    })
  }

  // After the outcome, in the background: a rule must never make a visitor wait.
  if (result.contactId) {
    reportEvent(publicEdgeContext(form.accountId), {
      trigger: 'form_submitted',
      objectKey: 'contact',
      entityId: result.contactId,
      accountSlug: form.accountSlug,
    })
  }

  return NextResponse.json({ ok: true, duplicate: result.duplicate ?? false }, { status: 200 })
}

/** "Email Address" -> email_address, so nobody renames fields in Webflow. */
const normaliseKey = (key: string): string =>
  key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

type WebflowPayload = {
  siteId?: string
  payload?: WebflowData
} & WebflowData

type WebflowData = {
  id?: string
  _id?: string
  name?: string
  formName?: string
  siteId?: string
  siteDomain?: string
  pageId?: string
  data?: Record<string, unknown>
  formResponse?: Record<string, unknown>
}
