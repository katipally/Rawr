import { linkAccountForToken, publicEdgeContext, recordClick } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'

/** The click redirect.
 *
 *  The destination is read from the row the token names, never from the request,
 *  so this cannot be turned into an open redirect that lends the tracking domain's
 *  reputation to somebody else's phishing page.
 *
 *  Recorded before the redirect rather than after: a person following a link is
 *  gone the instant the 302 lands, and a background write that loses the race
 *  loses the click. */
export const GET = async (
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> => {
  const { token } = await params
  const accountId = await linkAccountForToken(token)
  if (!accountId) {
    // An unknown token goes to the app's front door rather than nowhere: the
    // person clicked something in a real mail and deserves a page.
    return NextResponse.redirect(new URL('/', env.AUTH_URL))
  }

  const url = await recordClick(
    { ...publicEdgeContext(accountId), actorKind: 'public' },
    token,
    { userAgent: request.headers.get('user-agent') },
  )
  if (!url) return NextResponse.redirect(new URL('/', env.AUTH_URL))
  return NextResponse.redirect(url, { status: 302 })
}
