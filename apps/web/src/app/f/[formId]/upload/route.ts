import {
  beginFormUpload,
  FORM_UPLOAD_MIME,
  MAX_FORM_UPLOAD_BYTES,
  publicEdgeContext,
  publicFormById,
  storageKeyFor,
} from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { clientIp, CORS_HEADERS, rateLimit, readBody } from '~/server/edge.ts'
import { NOT_CONFIGURED, signedUpload, storageConfigured } from '~/server/storage.ts'

/** POST /f/:formId/upload — a signed URL for one file, and the id that names it.
 *
 *  No bytes pass through here. The browser is handed a one-shot PUT straight to
 *  storage, which is what keeps a ten megabyte CV off a request worker, and the
 *  id it gets back is the only thing the form posts. A visitor never sees, names
 *  or chooses a storage key, so there is nothing here to point at another tenant.
 *
 *  The size and type are declared rather than observed. That is not the last word
 *  on either: the row records what was claimed, storage enforces the key, and the
 *  submission is refused if the id was never issued for this form. */

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
  // The same answer as the submit endpoint gives, so an upload cannot be used to
  // discover which form ids exist when submitting cannot.
  if (!form || !form.isActive) {
    return json({ error: 'That form is not accepting submissions.' }, 404)
  }
  if (!form.fields.some((field) => field.type === 'file')) {
    return json({ error: 'That form does not accept files.' }, 400)
  }
  if (!storageConfigured) return json({ error: NOT_CONFIGURED }, 503)

  // Tighter than the submit limits: a signed URL is more expensive to hand out
  // than a lead is to refuse, and nobody attaches twenty files in a minute.
  const ip = clientIp(request) ?? 'unknown'
  const limit = rateLimit(`u:${formId}:${ip}`, 10, 300)
  if (!limit.allowed) {
    return json(
      { error: `That was too many files at once. Try again in ${limit.retryAfterSeconds} seconds.` },
      429,
      { 'retry-after': String(limit.retryAfterSeconds) },
    )
  }

  let body: Record<string, unknown>
  try {
    body = await readBody(request)
  } catch {
    return json({ error: 'That request could not be read.' }, 400)
  }

  const filename = String(body.filename ?? '').slice(0, 200)
  const mime = String(body.mime ?? '')
  const bytes = Number(body.bytes ?? 0)

  if (!filename) return json({ error: 'That file has no name.' }, 400)
  if (!Number.isInteger(bytes) || bytes <= 0) return json({ error: 'That file is empty.' }, 400)
  if (bytes > MAX_FORM_UPLOAD_BYTES) {
    return json(
      { error: `That file is larger than ${Math.round(MAX_FORM_UPLOAD_BYTES / 1024 / 1024)} MB.` },
      413,
    )
  }
  if (!FORM_UPLOAD_MIME.has(mime)) {
    return json({ error: 'That kind of file is not accepted here.' }, 415)
  }

  const storageKey = storageKeyFor(publicEdgeContext(form.accountId), {
    entityType: 'form',
    entityId: form.formId,
    filename,
  })
  const [id, signed] = await Promise.all([
    beginFormUpload(form, { storageKey, filename, bytes, mime }),
    signedUpload(storageKey),
  ])

  return json({ id, url: signed.url }, 200)
}
