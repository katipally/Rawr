import { acceptInvitation, membershipsForUser, readInvitationOffer } from '@rawr/db'
import { NextResponse } from 'next/server'
import { env } from '~/lib/env.ts'
import { invitePath } from '~/lib/links.ts'
import { INVITE_COOKIE, INVITE_COOKIE_MAX_AGE_SECONDS } from '~/server/invite.ts'
import { readSession, sessionFromMembership, writeSessionCookie } from '~/server/session.ts'

const NOT_ACCEPTED =
  'That invitation could not be accepted. It may have been used already or replaced. Ask whoever invited you to send another.'

/** Where an invitation link does its work. A route handler rather than the page,
 *  because a server component may read cookies and not set them, and because
 *  accepting a seat and parking a credential are side effects, not a page view.
 *
 *  Signed in as the invited address: accepts, moves the session into the account
 *  they were seated in and lands them at home. Signed in as anybody else: back to
 *  the page, which says whose invitation it is. Signed out: parks the invitation
 *  and sends them to sign in.
 *
 *  Safe to reach twice. The first visit spends the token, so every later one finds
 *  nothing to accept and the page says the link is spent. */
export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> => {
  const { token } = await params
  const offer = await readInvitationOffer(token)
  // A dead token gets no cookie: the page says why, and nothing is stored.
  if (!offer || offer.expired) {
    return NextResponse.redirect(new URL(invitePath(token), env.AUTH_URL))
  }

  const session = await readSession()
  if (session) {
    if (session.email.toLowerCase() !== offer.email.toLowerCase()) {
      return NextResponse.redirect(new URL(invitePath(token), env.AUTH_URL))
    }
    const joined = await acceptInvitation(token, session.userId)
    // Read after accepting: the request's cached list was taken before the seat.
    const seated = joined && (await membershipsForUser(session.userId)).find((row) => row.accountId === joined)
    if (!seated) {
      const home = new URL('/', env.AUTH_URL)
      home.searchParams.set('error', NOT_ACCEPTED)
      return NextResponse.redirect(home)
    }
    await writeSessionCookie(sessionFromMembership(seated))
    return NextResponse.redirect(new URL('/', env.AUTH_URL))
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
