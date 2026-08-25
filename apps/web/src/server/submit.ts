import {
  ATTRIBUTION_FIELDS,
  submitForm,
  type PublicForm,
  type SubmitInput,
  type SubmitResult,
} from '@rawr/db'
import type { NextRequest } from 'next/server'
import { turnstileConfigured } from '~/lib/env.ts'
import { ipHashOf, verifyTurnstile } from './edge.ts'

/** One capture path, shared by the JSON endpoint, the no-JS hosted page and the
 *  Webflow webhook, so the three cannot drift on scoring, attribution or the
 *  challenge. Each caller differs only in what it can prove about the submitter. */

export type SubmitOptions = {
  degradedSignals?: boolean
  idempotencyKey?: string | null
  /** Only the webhook has these; a browser sends them in the body. */
  attributionOverride?: { referrer?: string | null; pagePath?: string | null }
}

const text = (body: Record<string, unknown>, key: string): string | null => {
  const value = body[key]
  return typeof value === 'string' && value !== '' ? value : null
}

const inputFor = (
  request: NextRequest,
  form: PublicForm,
  body: Record<string, unknown>,
  options: SubmitOptions,
  challenge: SubmitInput['challenge'],
): SubmitInput => ({
  form,
  body,
  attribution: {
    rawQuery: text(body, ATTRIBUTION_FIELDS.rawQuery),
    referrer:
      options.attributionOverride?.referrer ??
      text(body, ATTRIBUTION_FIELDS.referrer) ??
      request.headers.get('referer'),
    landingPage: text(body, ATTRIBUTION_FIELDS.landingPage),
    pagePath: options.attributionOverride?.pagePath ?? text(body, ATTRIBUTION_FIELDS.pagePath),
  },
  ipHash: ipHashOf(request),
  userAgent: request.headers.get('user-agent'),
  visitorId: text(body, ATTRIBUTION_FIELDS.visitorId),
  degradedSignals: options.degradedSignals ?? false,
  challenge,
  idempotencyKey: options.idempotencyKey ?? null,
})

export const runSubmission = async (
  request: NextRequest,
  form: PublicForm,
  body: Record<string, unknown>,
  ip: string | null,
  options: SubmitOptions = {},
): Promise<SubmitResult> => {
  const first = await submitForm(inputFor(request, form, body, options, 'not-required'))
  if (!first.challengeRequired) return first

  // Scored into the challenge band, and nothing was written. Settle it here if we
  // can, rather than making the person do a second round trip.
  if (!turnstileConfigured) {
    // Nothing to attempt. Fail closed to quarantine: reviewable, not accepted,
    // not lost. This is also the state until open item 4's infrastructure lands.
    return submitForm(inputFor(request, form, body, options, 'unavailable'))
  }

  const token = body['cf-turnstile-response']
  if (typeof token !== 'string' || token === '') return first

  const outcome = await verifyTurnstile(token, ip)
  return submitForm(inputFor(request, form, body, options, outcome))
}
