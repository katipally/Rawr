import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  publicEdgeContext,
  publicFormBySlug,
} from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { clientIp } from '~/server/edge.ts'
import { queueSlackNotification } from '~/server/notify.ts'
import { runSubmission } from '~/server/submit.ts'
import { runAutomations } from '~/server/automations.ts'

/** POST /w/webflow — the fallback path of F3 §7.
 *
 *  Where marketing keeps a Webflow-designed native form, this is how it reaches
 *  Rawr without the paid hubspotonwebflow.com bridge. The primary path is
 *  replacing the form with the Rawr embed, which is better because Webflow's
 *  payload has no query string: only referrer and page survive, so attribution
 *  is weaker here. That is the cost of keeping the native form.
 *
 *  Webflow's Data API v2 signs "{x-webflow-timestamp}:{raw body}" with HMAC-SHA256
 *  using the OAuth app's client secret and sends the hex digest in
 *  x-webflow-signature. Webhooks created from a site dashboard or a site API key
 *  carry no signature at all, so this endpoint refuses them: an unsigned webhook
 *  is an open lead-injection endpoint. */

/** Webflow's own guidance. Older than this is a replay, not a delivery. */
const REPLAY_WINDOW_MS = 5 * 60 * 1000

/** Webflow retries on a non-2xx, so anything we cannot ever process answers 200
 *  with a reason rather than inviting an infinite retry. Only a genuine "try me
 *  again" answers 5xx. */
const accepted = (detail: string): NextResponse =>
  NextResponse.json({ ok: true, detail }, { status: 200 })

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!env.WEBFLOW_CLIENT_SECRET) {
    return NextResponse.json(
      { error: 'Webflow webhooks are not configured. Set WEBFLOW_CLIENT_SECRET.' },
      { status: 503 },
    )
  }

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

  if (!signatureMatches(timestamp, raw, signature)) {
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

  // Which Rawr form this is comes from the mapping in the URL of the webhook
  // itself, so a new Webflow form cannot silently create leads against an
  // unrelated Rawr form. Workspace and slug both come from the query string that
  // was configured when the webhook was created.
  const url = new URL(request.url)
  const workspace = url.searchParams.get('workspace')
  const slug = url.searchParams.get('form')
  if (!workspace || !slug) {
    return accepted('This webhook URL carries no workspace and form mapping, so nothing was recorded.')
  }

  const form = await publicFormBySlug(workspace, slug)
  if (!form || !form.isActive) return accepted('That Rawr form is not accepting submissions.')

  const answers = data.data ?? data.formResponse ?? {}
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(answers)) {
    body[normaliseKey(key)] = Array.isArray(value) ? value.map(String) : String(value ?? '')
  }

  const result = await runSubmission(request, form, body, clientIp(request), {
    degradedSignals: true,
    // Webflow's own submission id, so a redelivery is a no-op rather than a
    // second lead. Falls back to the site and timestamp when it is absent.
    idempotencyKey: data.id ?? data._id ?? `${siteId ?? 'webflow'}:${timestamp}`,
    attributionOverride: { pagePath: data.pageId ?? null, referrer: data.siteDomain ?? null },
  })

  if (result.errors?.length) {
    // A native form whose fields do not match the Rawr schema is a configuration
    // problem, not a transient one. Answering 200 stops the retry loop and the
    // reason is in the body for whoever set it up.
    return accepted(
      `Not recorded: ${result.errors.map((e) => e.message).join(' ')}`,
    )
  }

  if (result.notify) {
    queueSlackNotification({
      workspaceId: form.workspaceId,
      workspaceSlug: form.workspaceSlug,
      formId: form.formId,
      submissionId: result.submissionId,
      ...result.notify,
    })
  }

  // B11. After the outcome is decided, like the Slack post above, and on the
  // same background handle: a rule that sets a lifecycle stage must never make
  // a visitor wait, and must never fail their submission.
  if (result.contactId) {
    runAutomations(publicEdgeContext(form.workspaceId), {
      trigger: 'form_submitted',
      objectKey: 'contact',
      entityId: result.contactId,
      workspaceSlug: form.workspaceSlug,
    })
  }

  return NextResponse.json({ ok: true, duplicate: result.duplicate ?? false }, { status: 200 })
}

const signatureMatches = (timestamp: string, raw: string, signature: string): boolean => {
  const expected = createHmac('sha256', env.WEBFLOW_CLIENT_SECRET)
    .update(`${timestamp}:${raw}`)
    .digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  // Length has to match before timingSafeEqual, and comparing lengths first is
  // not a leak: the length of a hex digest is public.
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Webflow field names are whatever a designer typed: "Email Address", "First
 *  Name". Rawr keys are lowercase and underscored, so the two are reconciled
 *  here rather than forcing marketing to rename fields in Webflow. */
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
