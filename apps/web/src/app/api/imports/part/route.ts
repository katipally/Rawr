import { NextResponse, type NextRequest } from 'next/server'
import { UPLOAD_PART_BYTES } from '@rawr/db'
import { acceptPart } from '~/server/import-upload.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { readCapped } from '~/server/uploads.ts'

/** POST /api/imports/part?id=<run>&n=<part> — one part of an import's file.
 *
 *  Not a tRPC mutation, because the body is bytes: tRPC would base64 them into
 *  JSON, which is a third more bytes over the wire and the whole part in memory
 *  twice. Here the part is read with a cap and passed straight to storage.
 *
 *  The part number decides the byte range, so the same part sent twice is the
 *  same bytes and the second one is answered without touching storage. That is
 *  what makes an upload resumable. */

const json = (body: unknown, status: number): NextResponse => NextResponse.json(body, { status })

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const session = await readSession()
  if (!session) return json({ error: 'Sign in to import a file.' }, 401)

  const id = request.nextUrl.searchParams.get('id') ?? ''
  const n = Number(request.nextUrl.searchParams.get('n'))
  if (!Number.isInteger(n) || n < 1) return json({ error: 'That part number is not one.' }, 400)

  const body = await readCapped(request, UPLOAD_PART_BYTES)
  if (!body) return json({ error: 'That part is larger than a part may be.' }, 413)
  if (body.byteLength === 0) return json({ error: 'That part is empty.' }, 400)

  try {
    return json(await acceptPart(contextFrom(session), id, n, body), 200)
  } catch (cause) {
    return json({ error: cause instanceof Error ? cause.message : String(cause) }, 400)
  }
}
