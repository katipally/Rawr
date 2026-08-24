import { Google } from 'arctic'
import { env, googleConfigured } from '~/lib/env.ts'

export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback'

/** Sign-in scopes only. Gmail and Calendar are requested later, per user, by the
 *  features that need them, so a person who never uses Gmail sync is never asked
 *  for gmail.readonly. D7. */
export const SIGN_IN_SCOPES = ['openid', 'email', 'profile']

export const googleClient = (): Google => {
  if (!googleConfigured) {
    throw new Error(
      'Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or use the dev sign-in while open item 3 is outstanding.',
    )
  }
  return new Google(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    new URL(GOOGLE_CALLBACK_PATH, env.AUTH_URL).toString(),
  )
}

export type GoogleIdentity = {
  sub: string
  email: string
  name: string
  picture: string | null
  hostedDomain: string | null
  emailVerified: boolean
}

/** The hosted-domain claim is read from the signed id token, never from the email
 *  string and never from anything the browser sent. D6. */
export const identityFromIdToken = (claims: unknown): GoogleIdentity => {
  const c = claims as Record<string, unknown>
  const sub = typeof c.sub === 'string' ? c.sub : ''
  const email = typeof c.email === 'string' ? c.email : ''
  if (!sub || !email) throw new Error('Google returned an id token without a subject or email.')

  return {
    sub,
    email,
    name: typeof c.name === 'string' ? c.name : email,
    picture: typeof c.picture === 'string' ? c.picture : null,
    hostedDomain: typeof c.hd === 'string' ? c.hd : null,
    emailVerified: c.email_verified === true,
  }
}
