import { assertCanAttach, MAX_ATTACHMENT_BYTES } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { contextFrom, readSession } from '~/server/session.ts'
import { NOT_CONFIGURED, putObject, storageConfigured } from '~/server/storage.ts'
import { readCapped } from '~/server/uploads.ts'

/** POST /api/attachments/upload?key=... — the bytes of one attachment.
 *
 *  The key was minted by `attachments.begin`, which is where the permission and
 *  the size were already refused; this endpoint is the transport, and it checks
 *  both again because a key in a query string is a claim rather than a proof.
 *  The account is taken from the session and never from the key: a key whose
 *  first segment is not this account's id is somebody writing into another
 *  tenant's prefix, and it is refused without touching storage.
 *
 *  The row is still written afterwards, by `attachments.confirm`, so a failed
 *  upload leaves nothing on the record. */

const json = (body: unknown, status: number): NextResponse => NextResponse.json(body, { status })

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const session = await readSession()
  if (!session) return json({ error: 'Sign in to attach a file.' }, 401)
  if (!storageConfigured) return json({ error: NOT_CONFIGURED }, 503)

  const ctx = contextFrom(session)
  const key = request.nextUrl.searchParams.get('key') ?? ''
  if (!key.startsWith(`${ctx.accountId}/`)) {
    return json({ error: 'That file does not belong to this account.' }, 403)
  }

  // A declared size, or one byte when nothing was declared: the point of the
  // call here is the permission half, and the size half is done again below
  // against what actually arrives.
  const declared = Number(request.headers.get('content-length'))
  const claimed = Number.isFinite(declared) && declared > 0 ? declared : 1
  try {
    assertCanAttach(ctx, claimed)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'That file was refused.'
    return json({ error: message }, claimed > MAX_ATTACHMENT_BYTES ? 413 : 403)
  }

  const body = await readCapped(request, MAX_ATTACHMENT_BYTES)
  if (!body) {
    return json({ error: `That file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.` }, 413)
  }
  if (body.byteLength === 0) return json({ error: 'That file is empty.' }, 400)

  await putObject(key, body, request.headers.get('content-type') || 'application/octet-stream')
  return json({ bytes: body.byteLength }, 200)
}
