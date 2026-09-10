import { systemContext } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { hydrateMailboxBodies, RevokedError } from '~/server/gmail.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'

/** The worker asking the app to fetch the bodies of messages it already stored.
 *
 *  Separate from the sync for the same reason the sync is separate from the
 *  worker: it needs the Google client, and it must not be able to fail the sync.
 *  A message stored without its body is still on the record and still searchable
 *  by its snippet; a sync that failed because one 30MB mail timed out would have
 *  cost the whole page. */

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as
    | { accountId?: string; mailboxId?: string; limit?: number }
    | null
  if (!body?.accountId || !body?.mailboxId) {
    return NextResponse.json({ error: 'A account and a mailbox are both required.' }, { status: 400 })
  }

  try {
    const outcome = await hydrateMailboxBodies(
      systemContext(body.accountId),
      body.mailboxId,
      body.limit ?? 50,
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
