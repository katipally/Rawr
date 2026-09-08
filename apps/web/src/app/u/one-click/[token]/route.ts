import { enrollmentAccountForToken, publicEdgeContext, unsubscribeByToken } from '@rawr/db'
import { NextResponse } from 'next/server'

/** RFC 8058 one-click. Gmail and Outlook POST here when somebody presses the
 *  unsubscribe button in their own chrome, which is where people actually look.
 *
 *  Its own address rather than the page's, because the page has to answer GET for
 *  a person and a route handler cannot share a path with one. RFC 8058 puts this
 *  URL in the header and nowhere else, so nothing has to be the same URL as the
 *  link in the body.
 *
 *  Always 200, whatever happened: a provider that gets an error here may show the
 *  recipient a failure for something that did work, and may stop offering the
 *  button at all. */
export const POST = async (
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> => {
  const { token } = await params
  const accountId = await enrollmentAccountForToken(token)
  if (accountId) {
    await unsubscribeByToken({ ...publicEdgeContext(accountId), actorKind: 'public' }, token).catch(() => {})
  }
  return new NextResponse(null, { status: 200 })
}
