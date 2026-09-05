'use server'

import {
  publicEdgeContext,
  publicFormById,
} from '@rawr/db'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { NextRequest } from 'next/server'
import { checkSubmitLimits } from '~/server/edge.ts'
import { queueSlackNotification } from '~/server/notify.ts'
import { answersFromFormData, runSubmission } from '~/server/submit.ts'
import { reportEvent } from '~/server/automations.ts'

/** The no-JS submit path.
 *
 *  A Server Action rather than a route handler, because Next submits a plain
 *  HTTP POST for this form when JavaScript has not loaded or is turned off, and
 *  the same code then handles the enhanced case for free. There is one capture
 *  path behind both; only the signals differ.
 *
 *  Everything comes back through the URL on a redirect: per-field errors, and the
 *  answers already typed so nothing is lost. A redirect rather than a re-render
 *  keeps the back button and a page refresh from re-posting the form. */

const MAX_ECHO = 200

export const submitHostedForm = async (data: FormData): Promise<void> => {
  const formId = String(data.get('rawr_form_id') ?? '')
  const path = String(data.get('rawr_path') ?? '')
  const back = `/form/${path}`

  const form = await publicFormById(formId)
  if (!form || !form.isActive) redirect(`${back}?e=${errorParam('That form is no longer accepting submissions.')}`)

  const incoming = await headers()
  const ip = incoming.get('x-forwarded-for')?.split(',')[0]?.trim() ?? incoming.get('x-real-ip') ?? null

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
    // Echo back what was typed so a validation error does not empty the form.
    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== 'string' || value === '') continue
      if (key.startsWith('rawr_')) continue
      params.set(`v_${key}`, value.slice(0, MAX_ECHO))
    }
    redirect(`${back}?${params.toString()}`)
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
    reportEvent(publicEdgeContext(form.workspaceId), {
      trigger: 'form_submitted',
      objectKey: 'contact',
      entityId: result.contactId,
      workspaceSlug: form.workspaceSlug,
    })
  }

  if (result.success?.mode === 'redirect' && result.success.value) {
    redirect(result.success.value)
  }

  const held = result.state === 'quarantined' || result.state === 'confirmed_spam'
  redirect(`${back}?sent=1${held ? '&held=1' : ''}`)
}

const errorParam = (message: string): string =>
  encodeURIComponent(JSON.stringify({ form: message }))
