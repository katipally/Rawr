import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { env, googleCalendarConfigured } from '~/lib/env.ts'
import { calendarsPath } from '~/lib/links.ts'
import { generateCodeVerifier, generateState, googleClient } from '~/server/auth/google.ts'
import { CALENDAR_SCOPES } from '~/server/calendar.ts'
import { readSession } from '~/server/session.ts'

/** Calendar consent, asked separately from sign-in and only of the people who host
 *  meetings. 02-foundation.md §8: a person who never hosts is never asked for
 *  access to their calendar.
 *
 *  Incremental authorisation, so agreeing to this does not silently drop the
 *  scopes already granted. Offline access with an explicit consent prompt, because
 *  Google returns a refresh token on the first consent only, and without one the
 *  connection dies at the first token expiry an hour later. */

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const session = await readSession()
  if (!session) {
    return NextResponse.redirect(new URL('/sign-in', env.AUTH_URL))
  }

  const back = new URL(calendarsPath(session.workspaceSlug), env.AUTH_URL)

  if (!googleCalendarConfigured) {
    back.searchParams.set(
      'error',
      'Google Calendar is not configured on this deployment. It needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY (open items 3 and 9).',
    )
    return NextResponse.redirect(back)
  }

  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const url = googleClient().createAuthorizationURL(state, codeVerifier, CALENDAR_SCOPES)
  url.searchParams.set('hd', env.GOOGLE_HOSTED_DOMAIN)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('login_hint', session.email)

  const jar = await cookies()
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: 600,
  } as const
  jar.set('rawr_cal_state', state, options)
  jar.set('rawr_cal_verifier', codeVerifier, options)
  // Where to land afterwards. Read from the request rather than guessed, so
  // connecting from the page editor comes back to the page editor.
  jar.set('rawr_cal_return', request.nextUrl.searchParams.get('return') ?? back.pathname, options)

  return NextResponse.redirect(url)
}
