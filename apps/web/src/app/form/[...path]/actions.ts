'use server'

import {
  publicEdgeContext,
  publicFormById,
} from '@rawr/db'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { checkSubmitLimits, clientIpFrom } from '~/server/edge.ts'
import { ECHO_MAX_AGE_SECONDS, echoCookieName, echoCookiePath, encodeEcho } from '~/server/form-echo.ts'
import { queueSlackNotification } from '~/server/notify.ts'
import { hopHref } from '~/server/redirect-hop.ts'
import { answersFromFormData, runSubmission } from '~/server/submit.ts'
import { reportEvent } from '~/server/automations.ts'
import { recordCreated } from '~/server/record-events.ts'

/** The no-JS submit path.
 *
 *  A Server Action rather than a route handler, because Next submits a plain
 *  HTTP POST for this form when JavaScript has not loaded or is turned off, and
 *  the same code then handles the enhanced case for free. There is one capture
 *  path behind both; only the signals differ.
 *
 *  Everything comes back on a redirect: per-field errors in the URL, and the
 *  answers already typed in a short-lived cookie (see form-echo.ts) so nothing is
 *  lost and nothing typed reaches a URL. A redirect rather than a re-render keeps
 *  the back button and a page refresh from re-posting the form. */

export const submitHostedForm = async (data: FormData): Promise<void> => {
  const formId = String(data.get('rawr_form_id') ?? '')
  const path = String(data.get('rawr_path') ?? '')
  const back = `/form/${path}`

  const form = await publicFormById(formId)
  if (!form || !form.isActive) redirect(`${back}?e=${errorParam('That form is no longer accepting submissions.')}`)

  const incoming = await headers()
  const jar = await cookies()
  const cookiePath = echoCookiePath(path)
  // The left end of x-forwarded-for is whatever the caller chose to send, so
  // reading it put every forged header in its own rate-limit bucket.
  const ip = clientIpFrom((name) => incoming.get(name))

  const limit = checkSubmitLimits(form.formId, ip)
  if (!limit.allowed) {
    redirect(
      `${back}?e=${errorParam(`That was sent too quickly. Try again in ${limit.retryAfterSeconds} seconds. Anything you already sent was saved.`)}`,
    )
  }

  const body = answersFromFormData(data)

  // A Server Action has no NextRequest. The two fields the capture path reads
  // from one are the user agent and the referer, so a minimal stand-in is built
  // rather than threading a second shape through the shared code.
  const request = {
    headers: {
      get: (name: string) => incoming.get(name),
    },
  } as unknown as NextRequest

  const result = await runSubmission(request, form, body, ip, { degradedSignals: true })

  if (result.errors?.length) {
    const byKey: Record<string, string> = {}
    for (const error of result.errors) byKey[error.key] = error.message
    const params = new URLSearchParams({ e: JSON.stringify({ byKey }) })
    const echo = encodeEcho(form.fields, body)
    if (cookiePath && echo) {
      jar.set(echoCookieName(form.formId), echo, {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production',
        path: cookiePath,
        maxAge: ECHO_MAX_AGE_SECONDS,
      })
    } else if (cookiePath) jar.delete({ name: echoCookieName(form.formId), path: cookiePath })
    redirect(`${back}?${params.toString()}`)
  }

  if (cookiePath) jar.delete({ name: echoCookieName(form.formId), path: cookiePath })

  if (result.notify) {
    queueSlackNotification({
      accountId: form.accountId,
      accountSlug: form.accountSlug,
      formId: form.formId,
      submissionId: result.submissionId,
      ...result.notify,
    })
  }

  // B11. After the outcome is decided, like the Slack post above, and on the
  // same background handle: a rule that sets a lifecycle stage must never make
  // a visitor wait, and must never fail their submission.
  if (result.contactId) {
    reportEvent(publicEdgeContext(form.accountId), {
      trigger: 'form_submitted',
      objectKey: 'contact',
      entityId: result.contactId,
      accountSlug: form.accountSlug,
    })
  }
  if (result.contactCreated && result.contactId) {
    recordCreated(publicEdgeContext(form.accountId), { accountSlug: form.accountSlug }, 'contact', { id: result.contactId })
  }

  if (result.success?.mode === 'redirect' && result.success.value) {
    // A native POST answered with a cross-origin redirect is refused by
    // form-action 'self', so the page itself hops (see redirect-hop.ts).
    redirect(hopHref(result.success.value) ? `${back}?sent=1&go=1` : result.success.value)
  }

  const held = result.state === 'quarantined' || result.state === 'confirmed_spam'
  redirect(`${back}?sent=1${held ? '&held=1' : ''}`)
}

const errorParam = (message: string): string =>
  encodeURIComponent(JSON.stringify({ form: message }))
