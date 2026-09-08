import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { calendarAtSignIn, env, googleCalendarConfigured, hostedDomainRequired } from '~/lib/env.ts'
import { GOOGLE_CALLBACK_PATH, generateCodeVerifier, generateState, googleClient, SIGN_IN_SCOPES } from '~/server/auth/google.ts'
import { safeNext } from '~/server/auth/next.ts'
import { CALENDAR_SCOPES } from '~/server/calendar.ts'

/** Signing in, and connecting the calendar, in one consent.
 *
 *  Calendar access used to be a second trip to Google from the Calendars screen.
 *  Every host had to find that screen and know to press a button, and until they
 *  did their booking page offered nothing while looking perfectly configured. So
 *  the calendar scopes are asked for here, with sign-in, and the callback stores
 *  the grant: signing in is the whole setup.
 *
 *  The tradeoff, stated plainly: everybody is now asked for calendar access,
 *  including people who will never host a meeting. That is a step back from the
 *  incremental consent D7 asks for, and it is the price of nobody having a page
 *  that silently offers nothing. Gmail is deliberately not bundled in -- it is one
 *  of Google's restricted scopes, and asking the whole company for inbox access at
 *  sign-in is a different kind of request. */

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const state = generateState()
  const codeVerifier = generateCodeVerifier()

  // Only when the tokens can actually be stored, and only when this deployment is
  // allowed to ask. Without an encryption key there is nowhere to put a refresh
  // token; and a Google Account whose admin has not reviewed this app blocks the
  // whole authorisation over the calendar scopes, which would stop people signing
  // in to the CRM rather than merely leaving their calendar unconnected.
  //
  // `?calendar=0` is the way out of that for one person on one attempt: somebody
  // staring at Google's block page can still get in, and connect the calendar
  // later from the calendars screen once the Account admin has approved the app.
  const withCalendar =
    googleCalendarConfigured &&
    calendarAtSignIn &&
    request.nextUrl.searchParams.get('calendar') !== '0'
  const scopes = withCalendar ? [...SIGN_IN_SCOPES, ...CALENDAR_SCOPES] : SIGN_IN_SCOPES

  const url = googleClient(GOOGLE_CALLBACK_PATH).createAuthorizationURL(state, codeVerifier, scopes)
  // Pinning the chooser to a domain refuses every other account outright, so it is
  // set only where the deployment actually serves one company.
  if (hostedDomainRequired) url.searchParams.set('hd', env.GOOGLE_HOSTED_DOMAIN)
  // Google's default is to skip the chooser when exactly one account is signed in,
  // so after signing out of Rawr this used to bounce through Google and come
  // straight back as the same person: no chooser, no visible sign-in, and no way
  // to arrive as anybody else. Somebody who has just signed out is asking to
  // choose, so always ask.
  url.searchParams.set('prompt', 'select_account')
  if (withCalendar) {
    // A refresh token arrives on the first consent only, and free-busy is read
    // long after the access token has expired. The callback re-asks with
    // prompt=consent on the one occasion this does not produce one.
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('include_granted_scopes', 'true')
  }
  // Set by the callback when it needs a refresh token it did not get. One hop, and
  // the cookie it reads is cleared before the redirect, so this cannot loop.
  if (request.nextUrl.searchParams.get('consent') === '1') {
    url.searchParams.set('prompt', 'select_account consent')
  }

  const jar = await cookies()
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: 600,
  } as const
  jar.set('rawr_oauth_state', state, options)
  jar.set('rawr_oauth_verifier', codeVerifier, options)
  jar.set('rawr_next', safeNext(request.nextUrl.searchParams.get('next')), options)

  return NextResponse.redirect(url)
}
