import { systemContext } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { pushThreadToGmail } from '~/server/gmail.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'

/** The worker asking the app to send one thread's archive, trash and unread state on to
 *  Gmail. Rawr has already recorded the change; this only brings Gmail to it.
 *
 *  Same shape as the sync: the Google client lives here, the schedule lives in the worker,
 *  and the call carries no session. */

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as { accountId?: string; threadId?: string } | null
  if (!body?.accountId || !body?.threadId) {
    return NextResponse.json({ error: 'An account and a thread are both required.' }, { status: 400 })
  }

  try {
    await pushThreadToGmail(systemContext(body.accountId), body.threadId)
    return NextResponse.json({ pushed: true })
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 500 })
  }
}
