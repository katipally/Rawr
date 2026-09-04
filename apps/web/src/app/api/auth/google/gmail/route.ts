import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { devGmailEnabled, env, googleConfigured } from '~/lib/env.ts'
import { mailboxesPath } from '~/lib/links.ts'
import { generateCodeVerifier, generateState, googleClient } from '~/server/auth/google.ts'
import { GMAIL_SCOPES } from '~/server/gmail.ts'
import { readSession } from '~/server/session.ts'

/** Gmail consent, asked separately from sign-in and only of the people whose mail
 *  belongs on a record. F0 §8: somebody who never emails prospects is never asked
 *  for access to their inbox.
 *
 *  gmail.readonly and nothing else. D7 rejects send, modify and compose by name. */

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const session = await readSession()
  if (!session) return NextResponse.redirect(new URL('/sign-in', env.AUTH_URL))

  const back = new URL(mailboxesPath(), env.AUTH_URL)

  // The development mailbox needs no consent screen, so connecting is a POST to
  // the router rather than a redirect to Google. Saying so beats a broken redirect.
  if (!googleConfigured) {
    back.searchParams.set(
      'error',
      devGmailEnabled
        ? 'Google is not configured, so use "Connect the development mailbox" instead.'
        : 'Gmail sync needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and an internal consent screen (open item 3).',
    )
    return NextResponse.redirect(back)
  }

  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const url = googleClient().createAuthorizationURL(state, codeVerifier, GMAIL_SCOPES)
  url.searchParams.set('hd', env.GOOGLE_HOSTED_DOMAIN)
  // Offline with an explicit prompt: Google returns a refresh token on the first
  // consent only, and a back-fill runs far longer than an access token lives.
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
  jar.set('rawr_gmail_state', state, options)
  jar.set('rawr_gmail_verifier', codeVerifier, options)
  jar.set('rawr_gmail_return', request.nextUrl.searchParams.get('return') ?? back.pathname, options)

  return NextResponse.redirect(url)
}
