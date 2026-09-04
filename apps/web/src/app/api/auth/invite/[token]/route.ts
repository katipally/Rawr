import { readInvitationOffer } from '@rawr/db'
import { NextResponse } from 'next/server'
import { env } from '~/lib/env.ts'
import { INVITE_COOKIE, INVITE_COOKIE_MAX_AGE_SECONDS } from '~/server/invite.ts'

/** Parks the invitation on the browser and sends it to sign in. A route handler
 *  rather than the page itself, because a server component may read cookies and
 *  not set them, and because parking a credential is a side effect that belongs
 *  behind a deliberate click rather than a page view. */
export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> => {
  const { token } = await params
  const offer = await readInvitationOffer(token)
  // A dead token gets no cookie: the page says why, and nothing is stored.
  if (!offer || offer.expired) {
    return NextResponse.redirect(new URL(`/invite/${token}`, env.AUTH_URL))
  }

  const response = NextResponse.redirect(new URL('/sign-in', env.AUTH_URL))
  response.cookies.set(INVITE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: INVITE_COOKIE_MAX_AGE_SECONDS,
  })
  return response
}
