import {
  ATTRIBUTION_FIELDS,
  publicEdgeContext,
  submitForm,
  type PublicForm,
  type SubmitInput,
  type SubmitResult,
} from '@rawr/db'
import type { NextRequest } from 'next/server'
import { ipHashOf } from './edge.ts'
import { turnstileCredentials, verifyTurnstile } from './integrations/turnstile.ts'
import { sendOptInConfirmation } from './opt-in-mail.ts'

/** One capture path, shared by the JSON endpoint, the no-JS hosted page and the
 *  Webflow webhook, so the three cannot drift on scoring, attribution or the
 *  challenge. Each caller differs only in what it can prove about the submitter. */

export type SubmitOptions = {
  degradedSignals?: boolean
  /** Whether this caller can actually put a challenge in front of somebody. Only
   *  the embed endpoint can: it answers `challengeRequired` to a script that
   *  renders the widget and posts again. The hosted no-JS page and the Webflow
   *  webhook have nowhere to show one, so for them a challenge means the
   *  submission is discarded while the visitor is told it was sent. */
  canChallenge?: boolean
  idempotencyKey?: string | null
  /** Only the webhook has these; a browser sends them in the body. */
  attributionOverride?: { referrer?: string | null; pagePath?: string | null }
}

/** The answers out of a posted form, without the transport.
 *
 *  Three things ride along that are not answers: the two fields the hosted page
 *  uses to say which form this is, and React's own $ACTION_ID and its relatives,
 *  which it posts on the no-JS path so the server knows which action to run. The
 *  schema allowlist refuses anything it does not recognise, so leaving React's in
 *  made every submission without JavaScript fail with
 *  '"$ACTION_ID_..." is not a field on this form.'
 *
 *  A field key is ^[a-z][a-z0-9_]*$, so nothing a form can legitimately ask for
 *  starts with a dollar sign. Repeated keys become an array, which is how a
 *  multi_select arrives from a plain HTML form. */
export const answersFromFormData = (data: FormData): Record<string, unknown> => {
  const body: Record<string, unknown> = {}
  for (const key of new Set(data.keys())) {
    if (key === 'rawr_form_id' || key === 'rawr_path' || key.startsWith('$')) continue
    const all = data.getAll(key).map((value) => String(value))
    body[key] = all.length > 1 ? all : (all[0] ?? '')
  }
  return body
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

/** The site key rides back so the widget's endpoint does not re-read it. */
export type RunResult = SubmitResult & { challengeSiteKey: string | null }

export const runSubmission = async (
  request: NextRequest,
  form: PublicForm,
  body: Record<string, unknown>,
  ip: string | null,
  options: SubmitOptions = {},
): Promise<RunResult> => {
  const first = await submitForm(inputFor(request, form, body, options, 'not-required'))
  if (!first.challengeRequired) {
    askForConfirmations(form.accountId, first)
    return { ...first, challengeSiteKey: null }
  }

  // Scored into the challenge band, and nothing was written. Settle it here.
  const creds = await turnstileCredentials(publicEdgeContext(form.accountId))
  const settle = async (outcome: 'failed' | 'passed' | 'unavailable'): Promise<RunResult> => {
    const result = await submitForm(inputFor(request, form, body, options, outcome))
    askForConfirmations(form.accountId, result)
    return { ...result, challengeSiteKey: null }
  }

  // Fail closed to quarantine: reviewable, not accepted, not lost.
  if (!creds) return settle('unavailable')

  const token = body['cf-turnstile-response']
  if (typeof token !== 'string' || token === '') {
    // A caller with nowhere to show a widget must not get an id-less "success".
    if (!options.canChallenge) return settle('unavailable')
    return { ...first, challengeSiteKey: creds.siteKey }
  }

  return settle(await verifyTurnstile(creds, token, ip))
}

/** The confirmation mail for every opt-in on a type that asks for one.
 *
 *  Off the critical path, because the visitor is waiting for a thank-you and not
 *  for Gmail, and never fatal: the request and its token are already written, so
 *  a mail that fails is a mail somebody can be asked for again. */
const askForConfirmations = (accountId: string, result: SubmitResult): void => {
  const pending = result.confirmations ?? []
  if (pending.length === 0) return
  // Imported here rather than at the top: `after` comes from next/server, which
  // plain Node cannot resolve, and this file's parser is covered by unit tests
  // that run without a bundler.
  void import('./background.ts').then(({ inBackground }) => {
    for (const one of pending) {
      inBackground('subscription confirmation', () => sendOptInConfirmation(accountId, one))
    }
  })
}
