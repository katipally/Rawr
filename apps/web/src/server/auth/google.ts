import { createHash, randomBytes } from 'node:crypto'
import { env, googleConfigured } from '~/lib/env.ts'

/** Google's OAuth 2.1 authorization code flow with PKCE, written out.
 *
 *  This was the `arctic` package until it was deprecated in July 2026 along with
 *  the rest of the Oslo line. Its author's own guidance was to inline the forty
 *  lines rather than look for a successor, because a provider-agnostic wrapper
 *  around one provider's OAuth is mostly indirection: what is actually needed is
 *  three URLs, a form post, and knowing which errors mean "reconnect".
 *
 *  The surface below is deliberately the one the call sites already used, so the
 *  four routes and the two token refreshers did not have to change with it. */

/** Where Google sends the browser back, per flow.
 *
 *  Three different routes, so three different redirect URIs. Google checks the one
 *  in the token exchange against the one in the authorisation request and against
 *  the list registered on the OAuth client, so a flow that asks with one and
 *  exchanges with another is refused -- and a flow that asks with somebody else's
 *  lands on somebody else's route, which is what used to happen here: calendar and
 *  Gmail consent both came back to the sign-in callback, where the state cookie
 *  they set is not the one that is read, so the grant was never stored. Every one
 *  of these has to be registered as an authorised redirect URI on the Google
 *  client, or consent fails with redirect_uri_mismatch. */
export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback'
export const GOOGLE_CALENDAR_CALLBACK_PATH = '/api/auth/google/calendar/callback'
export const GOOGLE_GMAIL_CALLBACK_PATH = '/api/auth/google/gmail/callback'

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** Sign-in scopes only. Gmail and Calendar are requested later, per user, by the
 *  features that need them, so a person who never uses Gmail sync is never asked
 *  for gmail.readonly. D7. */
export const SIGN_IN_SCOPES = ['openid', 'email', 'profile']

/** 32 bytes, which is past the 128-bit floor RFC 6749 §10.10 asks of anything used
 *  to prevent guessing. base64url so it survives a URL and a cookie unescaped. */
export const generateState = (): string => randomBytes(32).toString('base64url')

/** RFC 7636 §4.1 allows 43 to 128 characters. 32 bytes encodes to 43, the shortest
 *  the spec permits, and every extra byte buys nothing against a hash. */
export const generateCodeVerifier = (): string => randomBytes(32).toString('base64url')

/** The error Google's token endpoint returns, in the shape RFC 6749 §5.2 defines.
 *  `code` is what callers branch on: invalid_grant means the person revoked access
 *  or changed their password, and retrying that forever is the loop
 *  the token rules forbid: a refresh loop that never gives up hands a revoked
 *  grant to Google for ever. */
export class OAuth2RequestError extends Error {
  readonly code: string
  readonly description: string | null

  constructor(code: string, description: string | null) {
    super(description ? `${code}: ${description}` : code)
    this.name = 'OAuth2RequestError'
    this.code = code
    this.description = description
  }
}

/** What the token endpoint answered, read once and exposed as methods because that
 *  is how the call sites already asked. */
export class GoogleTokens {
  readonly #raw: TokenResponse
  readonly #receivedAt: number

  constructor(raw: TokenResponse) {
    this.#raw = raw
    this.#receivedAt = Date.now()
  }

  accessToken(): string {
    if (!this.#raw.access_token) throw new Error('Google returned no access token.')
    return this.#raw.access_token
  }

  hasRefreshToken(): boolean {
    return typeof this.#raw.refresh_token === 'string' && this.#raw.refresh_token !== ''
  }

  refreshToken(): string {
    if (!this.#raw.refresh_token) {
      throw new Error('Google returned no refresh token. Ask for offline access with prompt=consent.')
    }
    return this.#raw.refresh_token
  }

  /** Null rather than a guess when Google did not say. A caller that stores null
   *  refreshes on the next use instead of trusting an invented expiry. */
  accessTokenExpiresAt(): Date | null {
    const seconds = this.#raw.expires_in
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
    // Measured from when the response arrived, not from now: a slow round trip
    // otherwise counts as time the token still has.
    return new Date(this.#receivedAt + seconds * 1000)
  }

  idToken(): string {
    if (!this.#raw.id_token) throw new Error('Google returned no id token. Was "openid" in the scopes?')
    return this.#raw.id_token
  }

  /** What was actually granted, which is not always what was asked for: Google's
   *  consent screen lets a person tick a subset. The calendar connection stores
   *  this so a later failure can say which scope is missing. */
  hasScopes(): boolean {
    return typeof this.#raw.scope === 'string' && this.#raw.scope.trim() !== ''
  }

  scopes(): string[] {
    return (this.#raw.scope ?? '').split(' ').filter(Boolean)
  }
}

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
  scope?: string
  error?: string
  error_description?: string
}

export class GoogleOAuth {
  readonly #clientId: string
  readonly #clientSecret: string
  readonly #redirectUri: string

  constructor(clientId: string, clientSecret: string, redirectUri: string) {
    this.#clientId = clientId
    this.#clientSecret = clientSecret
    this.#redirectUri = redirectUri
  }

  /** The URL the browser is sent to. Callers add Google's own extras afterwards:
   *  hd, access_type, prompt, include_granted_scopes, login_hint. */
  createAuthorizationURL(state: string, codeVerifier: string, scopes: string[]): URL {
    const url = new URL(AUTHORIZATION_ENDPOINT)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.#clientId)
    url.searchParams.set('redirect_uri', this.#redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('scope', scopes.join(' '))
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('code_challenge', challengeFor(codeVerifier))
    return url
  }

  validateAuthorizationCode(code: string, codeVerifier: string): Promise<GoogleTokens> {
    return this.#exchange({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.#redirectUri,
    })
  }

  refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
    return this.#exchange({ grant_type: 'refresh_token', refresh_token: refreshToken })
  }

  async #exchange(fields: Record<string, string>): Promise<GoogleTokens> {
    const body = new URLSearchParams({
      ...fields,
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
    })

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      // A sign-in should not hang on a slow Google. Ten seconds is far past the
      // normal round trip and far short of a person giving up on the page.
      signal: AbortSignal.timeout(10_000),
    })

    let parsed: TokenResponse
    try {
      parsed = (await response.json()) as TokenResponse
    } catch {
      throw new OAuth2RequestError('invalid_response', `Google answered ${response.status} with something that was not JSON.`)
    }

    // RFC 6749 §5.2. The error is in the body, so a 400 carrying invalid_grant is
    // what tells the caller to stop retrying rather than the status alone.
    if (!response.ok || parsed.error) {
      throw new OAuth2RequestError(parsed.error ?? `http_${response.status}`, parsed.error_description ?? null)
    }
    return new GoogleTokens(parsed)
  }
}

const challengeFor = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url')

const configured = (): void => {
  if (!googleConfigured) {
    throw new Error(
      'Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or use the dev sign-in while open item 3 is outstanding.',
    )
  }
}

/** The client for one flow, which has to name its own callback path.
 *
 *  Required rather than defaulted, and that is the whole point: it used to default
 *  to the sign-in path, so calendar and Gmail consent silently asked Google to
 *  redirect to the sign-in route, which reads a different state cookie and threw
 *  the grant away. A default is exactly what let two flows forget. Now a new flow
 *  cannot compile without saying where it comes back to.
 *
 *  Both routes in a flow must pass the same path: Google checks the redirect_uri in
 *  the token exchange against the one in the authorisation request. */
export const googleClient = (callbackPath: string): GoogleOAuth => {
  configured()
  return new GoogleOAuth(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    new URL(callbackPath, env.AUTH_URL).toString(),
  )
}

/** For the refresh grant only, which sends no redirect_uri at all. Its own function
 *  rather than a client built with an arbitrary path, so a reader does not have to
 *  work out which callback a token refresh supposedly belongs to. */
export const googleRefresher = (): GoogleOAuth => {
  configured()
  return new GoogleOAuth(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, '')
}

/** The claims out of an id token, without verifying its signature.
 *
 *  That is correct here and only here: this token came back over TLS from Google's
 *  own token endpoint in direct response to our authenticated request, which
 *  OpenID Connect Core §3.1.3.7 states is sufficient. A token that arrived any
 *  other way would have to be verified, and none does. */
export const decodeIdToken = (idToken: string): unknown => {
  const payload = idToken.split('.')[1]
  if (!payload) throw new Error('That id token is not a JWT.')
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new Error('That id token carried claims this build could not read.')
  }
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
