import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { acceptInvitation, membershipsForUser, signInWithGoogle } from '@rawr/db'
import { env } from '~/lib/env.ts'
import { workspaceInPath } from '~/lib/links.ts'
import {
  decodeIdToken,
  googleClient,
  identityFromIdToken,
  type GoogleIdentity,
} from '~/server/auth/google.ts'
import { safeNext } from '~/server/auth/next.ts'
import { INVITE_COOKIE } from '~/server/invite.ts'
import { sessionFromMembership, writeSessionCookie } from '~/server/session.ts'

const denied = (reason: string): NextResponse =>
  NextResponse.redirect(new URL(`/sign-in?error=${encodeURIComponent(reason)}`, env.AUTH_URL))

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  const jar = await cookies()
  const expectedState = jar.get('rawr_oauth_state')?.value
  const codeVerifier = jar.get('rawr_oauth_verifier')?.value
  const next = safeNext(jar.get('rawr_next')?.value ?? null)
  const inviteToken = jar.get(INVITE_COOKIE)?.value ?? null
  jar.delete('rawr_oauth_state')
  jar.delete('rawr_oauth_verifier')
  jar.delete('rawr_next')
  jar.delete(INVITE_COOKIE)

  if (request.nextUrl.searchParams.get('error')) {
    return denied('Google sign-in was cancelled.')
  }
  if (!code || !state || !expectedState || !codeVerifier) {
    return denied('That sign-in link is incomplete. Start again from the sign-in page.')
  }
  if (state !== expectedState) {
    return denied('That sign-in attempt did not match this browser. Start again.')
  }

  let identity: GoogleIdentity
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
  // A link somebody followed before signing in. It seats them, and it is checked
  // against the address they actually signed in with, so a forwarded link cannot
  // seat the wrong person. Read after sign-in because it needs their user id.
  if (inviteToken) await acceptInvitation(inviteToken, userId)

  const memberships = await membershipsForUser(userId)
  // Somebody following a link into a particular workspace should arrive in that
  // workspace. Without this they land in whichever membership came back first and
  // the page they asked for then bounces them through the switch handler.
  const asked = workspaceInPath(next)
  const membership = memberships.find((m) => m.workspaceSlug === asked) ?? memberships[0]
  if (!membership) {
    return denied(`${identity.email} signed in, but no workspace exists for ${identity.hostedDomain}.`)
  }

  await writeSessionCookie(sessionFromMembership(membership))
  return NextResponse.redirect(new URL(next, env.AUTH_URL))
}
