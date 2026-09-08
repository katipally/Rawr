import { saveGrant } from '@rawr/db'
import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { calendarsPath } from '~/lib/links.ts'
import { GOOGLE_CALENDAR_CALLBACK_PATH, googleClient } from '~/server/auth/google.ts'
import { contextFrom, readSession } from '~/server/session.ts'

/** Stores the grant. The tokens are encrypted with a key held outside this
 *  database before they ever reach a column, so a database dump is not a set of
 *  live Google credentials. */

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const session = await readSession()
  if (!session) return NextResponse.redirect(new URL('/sign-in', env.AUTH_URL))

  const jar = await cookies()
  const expectedState = jar.get('rawr_cal_state')?.value
  const codeVerifier = jar.get('rawr_cal_verifier')?.value
  const returnTo = jar.get('rawr_cal_return')?.value ?? calendarsPath(session.accountSlug)
  jar.delete('rawr_cal_state')
  jar.delete('rawr_cal_verifier')
  jar.delete('rawr_cal_return')

  const back = (message?: string): NextResponse => {
    const url = new URL(returnTo, env.AUTH_URL)
    if (message) url.searchParams.set('error', message)
    return NextResponse.redirect(url)
  }

  if (request.nextUrl.searchParams.get('error')) {
    return back('Calendar access was not granted, so no times can be offered for you yet.')
  }

  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  if (!code || !state || !expectedState || !codeVerifier) {
    return back('That calendar link is incomplete. Start again from the calendars screen.')
  }
  if (state !== expectedState) {
    return back('That attempt did not match this browser. Start again.')
  }

  try {
    const tokens = await googleClient(GOOGLE_CALENDAR_CALLBACK_PATH).validateAuthorizationCode(code, codeVerifier)
    if (!tokens.hasRefreshToken()) {
      // Without one, the connection would work for an hour and then fail in a way
      // nobody could explain. Better to refuse now and say why.
      return back(
        'Google did not return a refresh token, so this connection would stop working within the hour. Remove Rawr from your Google account permissions and connect again.',
      )
    }
    await saveGrant(contextFrom(session), {
      userId: session.userId,
      provider: 'google',
      calendarId: 'primary',
      accessToken: tokens.accessToken(),
      refreshToken: tokens.refreshToken(),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt(),
      scope: tokens.hasScopes() ? tokens.scopes().join(' ') : null,
    })
  } catch (cause) {
    return back(
      `That calendar could not be connected: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }

  return back()
}
