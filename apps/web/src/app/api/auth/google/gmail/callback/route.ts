import { saveMailbox } from '@rawr/db'
import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { mailboxesPath, safePath } from '~/lib/links.ts'
import { NOTICE_PARAM, type NoticeCode } from '~/lib/notices.ts'
import { GOOGLE_GMAIL_CALLBACK_PATH, googleClient } from '~/server/auth/google.ts'
import { authorisedAddress, grantedSending } from '~/server/gmail.ts'
import { contextFrom, readSession } from '~/server/session.ts'

/** Stores the mailbox. The tokens are encrypted with a key held outside this
 *  database before they reach a column, so a dump is not a set of live
 *  credentials. F0 §8. */

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const session = await readSession()
  if (!session) return NextResponse.redirect(new URL('/sign-in', env.AUTH_URL))

  const jar = await cookies()
  const expectedState = jar.get('rawr_gmail_state')?.value
  const codeVerifier = jar.get('rawr_gmail_verifier')?.value
  const returnTo = safePath(jar.get('rawr_gmail_return')?.value, mailboxesPath())
  jar.delete('rawr_gmail_state')
  jar.delete('rawr_gmail_verifier')
  jar.delete('rawr_gmail_return')

  const back = (notice?: NoticeCode): NextResponse => {
    const url = new URL(returnTo, env.AUTH_URL)
    if (notice) url.searchParams.set(NOTICE_PARAM, notice)
    return NextResponse.redirect(url)
  }

  if (request.nextUrl.searchParams.get('error')) {
    return back('gmail_denied')
  }

  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  if (!code || !state || !expectedState || !codeVerifier) {
    return back('gmail_incomplete')
  }
  if (state !== expectedState) return back('attempt_mismatch')

  try {
    const tokens = await googleClient(GOOGLE_GMAIL_CALLBACK_PATH).validateAuthorizationCode(code, codeVerifier)
    if (!tokens.hasRefreshToken()) {
      return back('gmail_no_refresh_token')
    }
    await saveMailbox(contextFrom(session), {
      userId: session.userId,
      email: await authorisedAddress(tokens.accessToken()),
      accessToken: tokens.accessToken(),
      refreshToken: tokens.refreshToken(),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt(),
      // What Google granted, not what was asked for: somebody can untick sending
      // on the consent screen, and a mailbox that claims it can send when it
      // cannot fails at the worst moment.
      canSend: grantedSending(tokens.hasScopes() ? tokens.scopes() : []),
    })
  } catch (cause) {
    console.error('[gmail] connecting a mailbox failed:', cause)
    return back('mailbox_failed')
  }

  return back()
}
