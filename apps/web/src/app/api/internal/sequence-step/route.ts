import { systemContext } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { RevokedError } from '~/server/gmail.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'
import { runStep } from '~/server/sequences/run-step.ts'

/** The worker asking the app to run one step.
 *
 *  Here rather than in the worker for the same reason the mailbox sync is: it
 *  needs the Google client and the token refresh that sign-in already owns, and
 *  two places that hold somebody's Google credentials is one too many. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as
    | { accountId?: string; enrollmentId?: string }
    | null
  if (!body?.accountId || !body?.enrollmentId) {
    return NextResponse.json({ error: 'A account and an enrollment are both required.' }, { status: 400 })
  }

  try {
    const outcome = await runStep(
      // A job's context: no actor, marketing's ceiling, which is what sending
      // outreach on somebody's behalf needs and nothing more.
      systemContext(body.accountId),
      body.enrollmentId,
    )
    return NextResponse.json(outcome)
  } catch (cause) {
    const revoked = cause instanceof RevokedError
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : String(cause), revoked },
      { status: revoked ? 409 : 500 },
    )
  }
}
