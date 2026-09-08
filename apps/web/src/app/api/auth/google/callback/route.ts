import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import {
  acceptInvitation,
  membershipsForUser,
  provisionNewAccount,
  readGrant,
  saveGrant,
  signInWithGoogle,
} from '@rawr/db'
import { env, googleCalendarConfigured, hostedDomainRequired } from '~/lib/env.ts'
import { accountInPath } from '~/lib/links.ts'
import { GOOGLE_CALLBACK_PATH, decodeIdToken, googleClient, identityFromIdToken, type GoogleIdentity, type GoogleTokens } from '~/server/auth/google.ts'
import { safeNext } from '~/server/auth/next.ts'
import { INVITE_COOKIE } from '~/server/invite.ts'
import { CALENDAR_SCOPES } from '~/server/calendar.ts'
import { contextFrom, sessionFromMembership, writeSessionCookie, type Session } from '~/server/session.ts'

/** Marks a sign-in that has already been sent back to Google for explicit consent,
 *  so it is sent back at most once. */
const CONSENT_COOKIE = 'rawr_oauth_consented'

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
  // Set when this sign-in is already the second attempt, asking explicitly for
  // consent. Read once and cleared, so the re-ask below can happen at most once
  // however Google answers.
  const alreadyReasked = jar.get(CONSENT_COOKIE)?.value === '1'
  jar.delete(CONSENT_COOKIE)
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
  let granted: GoogleTokens
  try {
    granted = await googleClient(GOOGLE_CALLBACK_PATH).validateAuthorizationCode(code, codeVerifier)
    identity = identityFromIdToken(decodeIdToken(granted.idToken()))
  } catch {
    return denied('Google would not confirm that sign-in. Start again.')
  }

  if (!identity.emailVerified) {
    return denied('That Google account has an unverified email address.')
  }
  if (hostedDomainRequired && identity.hostedDomain !== env.GOOGLE_HOSTED_DOMAIN) {
    return denied(`Rawr is limited to ${env.GOOGLE_HOSTED_DOMAIN} accounts.`)
  }

  // An identity whose domain an account claims joins it, on that account's default
  // view grants when it auto-joins. Everybody else is seated by an
  // invitation, which is checked against the address they signed in with.
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

  // A domain no account claimed opened one during sign-in, and an account with no
  // object definitions has no screens to land on. Provisioning is application
  // code, so it happens here rather than in the sign-in function, and it is
  // guarded so an ordinary sign-in costs one cheap read.
  for (const seat of memberships) {
    if (seat.isSuperAdmin) await provisionNewAccount(seat.accountId, userId)
  }

  // Somebody following a link into a particular account should arrive in that
  // account. Without this they land in whichever membership came back first and
  // the page they asked for then bounces them through the switch handler.
  const asked = accountInPath(next)
  const membership = memberships.find((m) => m.accountSlug === asked) ?? memberships[0]
  if (!membership) {
    return denied(
      identity.hostedDomain
        ? `${identity.email} signed in, but no account exists for ${identity.hostedDomain} and one could not be opened. Ask an admin to invite you.`
        : `${identity.email} signed in, but that account has no seat yet. Ask an admin to invite you from Settings, Users and Teams.`,
    )
  }

  const session = sessionFromMembership(membership)
  await writeSessionCookie(session)

  // The calendar half of the same consent. Written after the session because it is
  // an account-scoped write and the session is what names the account.
  //
  // Never fatal: somebody who ticked the sign-in boxes and not the calendar ones is
  // signed in, and their booking pages say what is missing. Refusing the sign-in
  // over it would lock people out of the CRM for declining a calendar.
  if (googleCalendarConfigured && granted.scopes().some((scope) => CALENDAR_SCOPES.includes(scope))) {
    if (granted.hasRefreshToken()) {
      try {
        await saveGrant(contextFrom(session), {
          userId,
          provider: 'google',
          calendarId: 'primary',
          accessToken: granted.accessToken(),
          refreshToken: granted.refreshToken(),
          accessTokenExpiresAt: granted.accessTokenExpiresAt(),
          scope: granted.hasScopes() ? granted.scopes().join(' ') : null,
        })
      } catch {
        // A grant that could not be stored is a booking page that offers nothing
        // and says so. It is not a reason to refuse somebody the CRM.
      }
    } else if (!alreadyReasked && !(await workingGrant(session))) {
      // Google returns a refresh token on the first consent only, so an account
      // that has approved before comes back without one. With nothing stored, the
      // connection would work for an hour and then fail; ask once more, explicitly
      // for consent, and come straight back here.
      //
      // Once, and the cookie is what makes it once: if the second attempt still
      // brings no refresh token, the person is signed in without a calendar and
      // the calendars screen says so. A sign-in that bounces off Google forever is
      // worse than a booking page that reports what is missing.
      const again = new URL('/api/auth/google', env.AUTH_URL)
      again.searchParams.set('consent', '1')
      again.searchParams.set('next', next)
      const answer = NextResponse.redirect(again)
      answer.cookies.set(CONSENT_COOKIE, '1', {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production',
        path: '/',
        maxAge: 600,
      })
      return answer
    }
  }

  return NextResponse.redirect(new URL(next, env.AUTH_URL))
}

/** Whether this person already has a connection that can be renewed. A grant with
 *  no refresh token is not one: it stops working at the first token expiry. */
const workingGrant = async (session: Session): Promise<boolean> => {
  try {
    const grant = await readGrant(contextFrom(session), session.userId)
    return grant !== null && grant.provider === 'google' && grant.refreshToken !== null
  } catch {
    return false
  }
}
