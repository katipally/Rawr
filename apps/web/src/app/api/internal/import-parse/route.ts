import { systemContext } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { parseUploadedFile } from '~/server/import-upload.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'

/** The worker asking the app to read an uploaded file into rows.
 *
 *  Here rather than in the worker for the reason the chunk runner is: the
 *  registry, the header naming and the mapping suggestion all live in the app,
 *  and a second copy of them is one too many.
 *
 *  One call reads the whole file. It is one pass over a stream and a few tens of
 *  inserts, so the request is seconds rather than the tens of minutes the old
 *  browser-driven upload took; a call that dies part way through leaves the run
 *  in 'parsing' with the rows it managed, and the next one carries on from there. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as { accountId?: string; runId?: string } | null
  if (!body?.accountId || !body?.runId) {
    return NextResponse.json({ error: 'An account and a run are both required.' }, { status: 400 })
  }

  try {
    const { id, rows } = await parseUploadedFile(systemContext(body.accountId), body.runId)
    return NextResponse.json({ id, rows })
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 500 },
    )
  }
}
