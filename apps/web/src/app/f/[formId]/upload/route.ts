import {
  beginFormUpload,
  FORM_UPLOAD_MIME,
  issuedUploadKey,
  MAX_FORM_UPLOAD_BYTES,
  publicEdgeContext,
  publicFormById,
  storageKeyFor,
} from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { clientIp, CORS_HEADERS, rateLimit, readBody } from '~/server/edge.ts'
import { NOT_CONFIGURED, putObject, storageConfigured } from '~/server/storage.ts'
import { readCapped } from '~/server/uploads.ts'

/** One file for one form fill, in two calls.
 *
 *  POST issues an id and refuses everything refusable before a byte moves. PUT
 *  carries the bytes under that id. A visitor never sees, names or chooses a
 *  storage key, so there is nothing here to point at another tenant, and the id
 *  is the only thing the form itself posts.
 *
 *  The bytes come through this endpoint rather than going straight to storage
 *  because the hosted form page may only open connections to this origin, and a
 *  PUT to a bucket on another host is refused by the browser before it is made.
 *
 *  On POST the size and type are declared rather than observed. That is not the
 *  last word on either: PUT counts what actually arrives, the row records what
 *  was claimed, and the submission is refused if the id was never issued for
 *  this form. */

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
  const id = await beginFormUpload(form, { storageKey, filename, bytes, mime })

  return json({ id }, 200)
}

/** PUT /f/:formId/upload?id=... — the bytes of a file POST already issued an id
 *  for. The key comes from that row and never from the caller, and a row already
 *  attached to a submission cannot be written over. */
export const PUT = async (
  request: NextRequest,
  { params }: { params: Promise<{ formId: string }> },
): Promise<NextResponse> => {
  const { formId } = await params

  const form = await publicFormById(formId)
  if (!form || !form.isActive) {
    return json({ error: 'That form is not accepting submissions.' }, 404)
  }
  if (!storageConfigured) return json({ error: NOT_CONFIGURED }, 503)

  const issued = await issuedUploadKey(form, request.nextUrl.searchParams.get('id') ?? '')
  if (!issued) return json({ error: 'That upload was not offered for this form.' }, 404)

  const body = await readCapped(request, MAX_FORM_UPLOAD_BYTES)
  if (!body) {
    return json(
      { error: `That file is larger than ${Math.round(MAX_FORM_UPLOAD_BYTES / 1024 / 1024)} MB.` },
      413,
    )
  }
  if (body.byteLength === 0) return json({ error: 'That file is empty.' }, 400)

  await putObject(issued.storageKey, body, issued.mime || 'application/octet-stream')
  return json({ bytes: body.byteLength }, 200)
}
