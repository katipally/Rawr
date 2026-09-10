import { systemContext } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { RevokedError, syncMailbox } from '~/server/gmail.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'

/** The worker asking the app to read one mailbox.
 *
 *  The sync lives here rather than in the worker because it needs the Google OAuth
 *  client and the token refresh path that sign-in already owns, and two places that
 *  know how to hold somebody's Google credentials is one too many. The worker owns
 *  the schedule; this owns the call.
 *
 *  Not part of the public edge and not part of tRPC: it carries no session, acts
 *  with a job's context, and is reachable only with the shared secret. */

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as
    | { accountId?: string; mailboxId?: string }
    | null
  if (!body?.accountId || !body?.mailboxId) {
    return NextResponse.json({ error: 'A account and a mailbox are both required.' }, { status: 400 })
  }

  try {
    const outcome = await syncMailbox(
      // A job's context: no actor, marketing's ceiling, which is what reading mail
      // onto contacts needs and nothing more.
      systemContext(body.accountId),
      body.mailboxId,
    )
    return NextResponse.json(outcome)
  } catch (cause) {
    const revoked = cause instanceof RevokedError
    return NextResponse.json(
      {
        error: cause instanceof Error ? cause.message : String(cause),
        // The worker uses this to stop retrying rather than burning four attempts
        // against somebody having withdrawn consent.
        revoked,
      },
      { status: revoked ? 409 : 500 },
    )
  }
}
