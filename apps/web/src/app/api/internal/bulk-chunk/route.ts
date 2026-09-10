import { runBulkChunk, systemContext } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'

/** The worker asking the app to apply one chunk of a bulk action.
 *
 *  Here rather than in the worker for the reason the import chunk is: deleting a
 *  record detaches its browsing history, writes its audit row and leaves its
 *  timeline alone, and a second copy of those rules living in the worker is one
 *  too many.
 *
 *  One chunk per call, so a run that is failing stops after one chunk's worth of
 *  damage rather than mid-selection. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as
    | { accountId?: string; operationId?: string }
    | null
  if (!body?.accountId || !body?.operationId) {
    return NextResponse.json({ error: 'An account and an operation are both required.' }, { status: 400 })
  }

  try {
    return NextResponse.json(await runBulkChunk(systemContext(body.accountId), body.operationId))
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 500 },
    )
  }
}
