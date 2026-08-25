import { publicFormById } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import {
  checkSubmitLimits,
  clientIp,
  CORS_HEADERS,
  PayloadTooLarge,
  readBody,
} from '~/server/edge.ts'
import { queueSlackNotification } from '~/server/notify.ts'
import { runSubmission } from '~/server/submit.ts'

/** POST /f/:formId — the capture path, F3 §4.
 *
 *  The workspace is resolved from the form id and from nothing the caller sent.
 *  This endpoint creates a lead and returns no record data, so there is nothing
 *  to enumerate here even with a valid form id. */

export const OPTIONS = (): NextResponse =>
  new NextResponse(null, { status: 204, headers: CORS_HEADERS })

const json = (body: unknown, status: number, extra: Record<string, string> = {}): NextResponse =>
  NextResponse.json(body, { status, headers: { ...CORS_HEADERS, ...extra } })

export const POST = async (
  request: NextRequest,
  { params }: { params: Promise<{ formId: string }> },
): Promise<NextResponse> => {
  const { formId } = await params

  const form = await publicFormById(formId)
  // The same answer for "no such form" and "form turned off", so the endpoint
  // cannot be used to discover which ids exist.
  if (!form || !form.isActive) {
    return json({ error: 'That form is not accepting submissions.' }, 404)
  }

  const ip = clientIp(request)
  const limit = checkSubmitLimits(form.formId, ip)
  if (!limit.allowed) {
    return json(
      {
        error: `That was sent too quickly. Try again in ${limit.retryAfterSeconds} seconds. Anything you already sent was saved.`,
      },
      429,
      { 'retry-after': String(limit.retryAfterSeconds) },
    )
  }

  let body: Record<string, unknown>
  try {
    body = await readBody(request)
  } catch (cause) {
    if (cause instanceof PayloadTooLarge) return json({ error: cause.message }, 413)
    return json({ error: 'That submission could not be read.' }, 400)
  }

  const result = await runSubmission(request, form, body, ip)

  if (result.errors?.length) return json({ ok: false, errors: result.errors }, 422)

  if (result.challengeRequired) {
    // 200, not a 4xx: the caller is being asked for one more step, and an error
    // status reads as "your input was wrong" in every embed and every log.
    return json({ ok: false, challenge: { provider: 'turnstile', siteKey: env.TURNSTILE_SITE_KEY } }, 200)
  }

  if (result.notify) {
    // After the outcome is decided, never before. A Slack outage must not fail a
    // lead capture. §4 steps 8 to 10.
    queueSlackNotification({
      workspaceId: form.workspaceId,
      workspaceSlug: form.workspaceSlug,
      formId: form.formId,
      submissionId: result.submissionId,
      ...result.notify,
    })
  }

  return json(
    {
      ok: true,
      // The caller learns whether it was accepted, never why it was held. Telling
      // a bot which rule caught it is how the next attempt gets past it.
      held: result.state === 'quarantined' || result.state === 'confirmed_spam',
      success: result.success,
    },
    200,
  )
}
