import { runImportChunk, systemContext } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'

/** The worker asking the app to import one chunk of a file.
 *
 *  Here rather than in the worker for the reason the sequence step is: a row
 *  becomes a record through the same registry, dedupe and audit path a person's
 *  edit takes, and a second copy of that is one too many.
 *
 *  One chunk per call, so the caller decides the pace and a run that is stopped
 *  stops between chunks rather than mid-write. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as
    | { accountId?: string; runId?: string }
    | null
  if (!body?.accountId || !body?.runId) {
    return NextResponse.json({ error: 'An account and a run are both required.' }, { status: 400 })
  }

  try {
    // A job's context: no actor, marketing's ceiling. The rows were accepted from
    // a person who could write them; running the file needs nothing more.
    return NextResponse.json(await runImportChunk(systemContext(body.accountId), body.runId))
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 500 },
    )
  }
}
