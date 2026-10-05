import { enrollmentAccountForToken, publicEdgeContext, unsubscribeByToken } from '@rawr/db'
import { NextResponse } from 'next/server'
import { describe, logError } from '~/server/log.ts'

/** RFC 8058 one-click. Gmail and Outlook POST here when somebody presses the
 *  unsubscribe button in their own chrome, which is where people actually look.
 *
 *  Its own address rather than the page's, because the page has to answer GET for
 *  a person and a route handler cannot share a path with one. RFC 8058 puts this
 *  URL in the header and nowhere else, so nothing has to be the same URL as the
 *  link in the body.
 *
 *  200 whenever there is nothing left to do: the opt-out was recorded, the token
 *  is unknown, or it was already used. A provider that is told 4xx for those may
 *  show the recipient a failure for something that did work, and may stop offering
 *  the button at all. A fault on our side is not that, and answering 200 to it
 *  tells the provider, and so the recipient, that they are off a list they are
 *  still on. It gets a 500 and a line in the log. */
export const POST = async (
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> => {
  const { token } = await params
  try {
    const accountId = await enrollmentAccountForToken(token)
    if (accountId) {
      await unsubscribeByToken({ ...publicEdgeContext(accountId), actorKind: 'public' }, token)
    }
  } catch (cause) {
    logError({ msg: 'one-click unsubscribe failed', error: describe(cause) })
    return new NextResponse(null, { status: 500 })
  }
  return new NextResponse(null, { status: 200 })
}
