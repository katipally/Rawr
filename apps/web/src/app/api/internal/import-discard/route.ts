import { systemContext } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { discardUpload } from '~/server/import-upload.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'

/** The worker asking the app to give up on an upload nobody came back to.
 *
 *  Here rather than in the worker because the file is in storage, which the
 *  worker cannot reach, and abandoning it has to be explicit: an incomplete
 *  multipart upload is not an object, so it appears in no listing and nothing
 *  else ever cleans it up. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as { accountId?: string; runId?: string } | null
  if (!body?.accountId || !body?.runId) {
    return NextResponse.json({ error: 'An account and a run are both required.' }, { status: 400 })
  }

  try {
    await discardUpload(systemContext(body.accountId), body.runId)
    return NextResponse.json({ discarded: true })
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 500 })
  }
}
