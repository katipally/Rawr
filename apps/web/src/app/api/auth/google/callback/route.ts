import { decodeIdToken } from 'arctic'
import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { membershipsForUser, signInWithGoogle } from '@rawr/db'
import { env } from '~/lib/env.ts'
import { googleClient, identityFromIdToken } from '~/server/auth/google.ts'
import { sessionFromMembership, writeSessionCookie } from '~/server/session.ts'

const denied = (reason: string): NextResponse =>
  NextResponse.redirect(new URL(`/sign-in?error=${encodeURIComponent(reason)}`, env.AUTH_URL))

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  const jar = await cookies()
  const expectedState = jar.get('rawr_oauth_state')?.value
  const codeVerifier = jar.get('rawr_oauth_verifier')?.value
  jar.delete('rawr_oauth_state')
  jar.delete('rawr_oauth_verifier')

  if (request.nextUrl.searchParams.get('error')) {
    return denied('Google sign-in was cancelled.')
  }
  if (!code || !state || !expectedState || !codeVerifier) {
    return denied('That sign-in link is incomplete. Start again from the sign-in page.')
  }
  if (state !== expectedState) {
    return denied('That sign-in attempt did not match this browser. Start again.')
  }

  let identity
  try {
    const tokens = await googleClient().validateAuthorizationCode(code, codeVerifier)
    identity = identityFromIdToken(decodeIdToken(tokens.idToken()))
  } catch {
    return denied('Google would not confirm that sign-in. Start again.')
  }

  if (!identity.emailVerified) {
    return denied('That Google account has an unverified email address.')
  }
  if (identity.hostedDomain !== env.GOOGLE_HOSTED_DOMAIN) {
    return denied(`Rawr is limited to ${env.GOOGLE_HOSTED_DOMAIN} accounts.`)
  }

  // A verified @datasaur.ai identity joins every workspace on that domain as a
  // viewer. An admin raises the role from Settings, under Members.
  const userId = await signInWithGoogle({
    sub: identity.sub,
    email: identity.email,
    name: identity.name,
    picture: identity.picture,
    hostedDomain: identity.hostedDomain,
  })
  const memberships = await membershipsForUser(userId)
  const membership = memberships[0]
  if (!membership) {
    return denied(`${identity.email} signed in, but no workspace exists for ${identity.hostedDomain}.`)
  }

  await writeSessionCookie(sessionFromMembership(membership))
  return NextResponse.redirect(new URL('/', env.AUTH_URL))
}
