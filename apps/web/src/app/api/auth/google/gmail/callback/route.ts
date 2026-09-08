import { saveMailbox } from '@rawr/db'
import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { mailboxesPath } from '~/lib/links.ts'
import { GOOGLE_GMAIL_CALLBACK_PATH, googleClient } from '~/server/auth/google.ts'
import { grantedSending } from '~/server/gmail.ts'
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
  const returnTo = jar.get('rawr_gmail_return')?.value ?? mailboxesPath()
  jar.delete('rawr_gmail_state')
  jar.delete('rawr_gmail_verifier')
  jar.delete('rawr_gmail_return')

  const back = (message?: string): NextResponse => {
    const url = new URL(returnTo, env.AUTH_URL)
    if (message) url.searchParams.set('error', message)
    return NextResponse.redirect(url)
  }

  if (request.nextUrl.searchParams.get('error')) {
    return back('Gmail access was not granted, so no history can be read for you.')
  }

  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  if (!code || !state || !expectedState || !codeVerifier) {
    return back('That link is incomplete. Start again from the mailboxes screen.')
  }
  if (state !== expectedState) return back('That attempt did not match this browser. Start again.')

  try {
    const tokens = await googleClient(GOOGLE_GMAIL_CALLBACK_PATH).validateAuthorizationCode(code, codeVerifier)
    if (!tokens.hasRefreshToken()) {
      return back(
        'Google did not return a refresh token, so the back-fill would stop within the hour. Remove Rawr from your Google account permissions and connect again.',
      )
    }
    await saveMailbox(contextFrom(session), {
      userId: session.userId,
      email: session.email,
      accessToken: tokens.accessToken(),
      refreshToken: tokens.refreshToken(),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt(),
      // What Google granted, not what was asked for: somebody can untick sending
      // on the consent screen, and a mailbox that claims it can send when it
      // cannot fails at the worst moment.
      canSend: grantedSending(tokens.hasScopes() ? tokens.scopes() : []),
    })
  } catch (cause) {
    return back(
      `That mailbox could not be connected: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }

  return back()
}
