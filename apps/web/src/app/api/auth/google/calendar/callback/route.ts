import { saveGrant } from '@rawr/db'
import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { calendarsPath, safePath } from '~/lib/links.ts'
import { NOTICE_PARAM, type NoticeCode } from '~/lib/notices.ts'
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
  const returnTo = safePath(jar.get('rawr_cal_return')?.value, calendarsPath(session.accountSlug))
  jar.delete('rawr_cal_state')
  jar.delete('rawr_cal_verifier')
  jar.delete('rawr_cal_return')

  const back = (notice?: NoticeCode): NextResponse => {
    const url = new URL(returnTo, env.AUTH_URL)
    if (notice) url.searchParams.set(NOTICE_PARAM, notice)
    return NextResponse.redirect(url)
  }

  if (request.nextUrl.searchParams.get('error')) {
    return back('calendar_denied')
  }

  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  if (!code || !state || !expectedState || !codeVerifier) {
    return back('calendar_incomplete')
  }
  if (state !== expectedState) {
    return back('attempt_mismatch')
  }

  try {
    const tokens = await googleClient(GOOGLE_CALENDAR_CALLBACK_PATH).validateAuthorizationCode(code, codeVerifier)
    if (!tokens.hasRefreshToken()) {
      // Without one, the connection would work for an hour and then fail in a way
      // nobody could explain. Better to refuse now and say why.
      return back('calendar_no_refresh_token')
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
    console.error('[calendar] connecting a calendar failed:', cause)
    return back('calendar_failed')
  }

  return back()
}
