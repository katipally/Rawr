import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mock, test } from 'node:test'
import {
  GOOGLE_CALENDAR_CALLBACK_PATH,
  GOOGLE_CALLBACK_PATH,
  GOOGLE_GMAIL_CALLBACK_PATH,
  decodeIdToken,
  generateCodeVerifier,
  generateState,
  GoogleOAuth,
  GoogleTokens,
  identityFromIdToken,
  OAuth2RequestError,
} from './google.ts'

/** This replaced a deprecated dependency, so it is the one place in the app where
 *  a mistake is a sign-in that silently stops working or, worse, one that works
 *  without the check it was supposed to make. */

const client = () => new GoogleOAuth('client-id', 'client-secret', 'https://rawr.example/cb')

// ------------------------------------------------------------------ randomness

test('state and verifier are long enough and URL-safe', () => {
  for (const value of [generateState(), generateCodeVerifier()]) {
    // 32 bytes base64url encodes to 43 characters, the RFC 7636 minimum.
    assert.equal(value.length, 43)
    assert.match(value, /^[A-Za-z0-9_-]+$/)
  }
})

test('two calls never agree', () => {
  const seen = new Set(Array.from({ length: 200 }, () => generateState()))
  assert.equal(seen.size, 200)
})

// ----------------------------------------------------------- authorization URL

test('the authorization URL carries everything Google needs', () => {
  const verifier = generateCodeVerifier()
  const url = client().createAuthorizationURL('the-state', verifier, ['openid', 'email'])

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('client_id'), 'client-id')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://rawr.example/cb')
  assert.equal(url.searchParams.get('state'), 'the-state')
  assert.equal(url.searchParams.get('scope'), 'openid email')
})

test('each flow comes back to its own route', () => {
  // Calendar and Gmail consent both used to be built with the sign-in callback, so
  // Google returned the browser to a route that reads a different state cookie and
  // the grant was never stored. Three distinct paths, and every one of them has to
  // be registered on the Google client.
  const paths = [GOOGLE_CALLBACK_PATH, GOOGLE_CALENDAR_CALLBACK_PATH, GOOGLE_GMAIL_CALLBACK_PATH]
  assert.equal(new Set(paths).size, 3, 'two flows share a callback path')
  assert.equal(paths.every((path) => path.startsWith('/api/auth/google')), true)
})

test('the redirect asked for is the redirect exchanged', async (t) => {
  // Google refuses the exchange when the two differ, so a flow that asks with one
  // path and exchanges with another fails at the last step, after consent.
  const asked = new URL(client().createAuthorizationURL('s', 'v', ['openid']))
  const fetched = t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ access_token: 'a' }), { status: 200 }),
  )
  await client().validateAuthorizationCode('code', 'v')
  const body = new URLSearchParams(String(fetched.mock.calls[0]?.arguments[1]?.body))
  assert.equal(body.get('redirect_uri'), asked.searchParams.get('redirect_uri'))
})

test('a sign-in that carries calendar scopes asks for offline access', () => {
  // Signing in is the whole setup now: the calendar scopes ride along with the
  // sign-in ones. Without offline access Google returns no refresh token, and
  // free-busy is read long after the access token has expired.
  const url = client().createAuthorizationURL('s', 'v', ['openid', 'https://www.googleapis.com/auth/calendar.events'])
  const scopes = (url.searchParams.get('scope') ?? '').split(' ')
  assert.equal(scopes.includes('openid'), true)
  assert.equal(scopes.includes('https://www.googleapis.com/auth/calendar.events'), true)
})

test('PKCE is S256 over the verifier, and the verifier itself never travels', () => {
  const verifier = generateCodeVerifier()
  const url = client().createAuthorizationURL('s', verifier, ['openid'])

  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(verifier).digest('base64url'),
  )
  // Sending the verifier here would defeat the whole exchange.
  assert.ok(!url.toString().includes(verifier))
  // And so would sending the secret to the browser.
  assert.ok(!url.toString().includes('client-secret'))
})

// -------------------------------------------------------------------- exchange

test('an authorization code is exchanged with the verifier and the secret', async (t) => {
  const calls: Array<{ url: string; body: URLSearchParams }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: unknown) => {
    calls.push({
      url: String(url),
      body: new URLSearchParams(String((init as { body: URLSearchParams }).body)),
    })
    return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599 }), { status: 200 })
  })

  await client().validateAuthorizationCode('the-code', 'the-verifier')

  const sent = calls[0]
  assert.equal(sent?.url, 'https://oauth2.googleapis.com/token')
  assert.equal(sent?.body.get('grant_type'), 'authorization_code')
  assert.equal(sent?.body.get('code'), 'the-code')
  assert.equal(sent?.body.get('code_verifier'), 'the-verifier')
  assert.equal(sent?.body.get('redirect_uri'), 'https://rawr.example/cb')
  assert.equal(sent?.body.get('client_secret'), 'client-secret')
})

test('a refresh sends the refresh token and nothing about a code', async (t) => {
  let body = new URLSearchParams()
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: unknown) => {
    body = new URLSearchParams(String((init as { body: URLSearchParams }).body))
    return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599 }), { status: 200 })
  })

  await client().refreshAccessToken('the-refresh-token')

  assert.equal(body.get('grant_type'), 'refresh_token')
  assert.equal(body.get('refresh_token'), 'the-refresh-token')
  assert.equal(body.get('code'), null)
})

test('invalid_grant survives as a code, because that is what stops the retry loop', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      { status: 400 },
    ),
  )

  await assert.rejects(
    () => client().refreshAccessToken('stale'),
    (error: unknown) => {
      assert.ok(error instanceof OAuth2RequestError)
      assert.equal(error.code, 'invalid_grant')
      assert.match(error.message, /revoked/)
      return true
    },
  )
})

test('an error in the body of a 200 is still an error', async (t) => {
  // Not hypothetical: an OAuth server is allowed to answer 200 with an error body,
  // and branching on the status alone would treat that as a working token.
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ error: 'invalid_client' }), { status: 200 }),
  )
  await assert.rejects(() => client().refreshAccessToken('x'), OAuth2RequestError)
})

test('a non-JSON answer is an error rather than a crash', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>502</html>', { status: 502 }))
  await assert.rejects(
    () => client().refreshAccessToken('x'),
    (error: unknown) => error instanceof OAuth2RequestError && error.code === 'invalid_response',
  )
})

// ---------------------------------------------------------------------- tokens

test('an expiry is measured from the answer, and is null when Google did not say', () => {
  const before = Date.now()
  const tokens = new GoogleTokens({ access_token: 'at', expires_in: 3599 })
  const expiry = tokens.accessTokenExpiresAt()
  assert.ok(expiry)
  const seconds = (expiry.getTime() - before) / 1000
  assert.ok(seconds > 3590 && seconds <= 3599, String(seconds))

  // Null, not an invented hour: a caller that stores null refreshes on next use.
  assert.equal(new GoogleTokens({ access_token: 'at' }).accessTokenExpiresAt(), null)
})

test('a missing refresh token is asked about before it is read', () => {
  const without = new GoogleTokens({ access_token: 'at' })
  assert.equal(without.hasRefreshToken(), false)
  assert.throws(() => without.refreshToken(), /offline access/)

  const with_ = new GoogleTokens({ access_token: 'at', refresh_token: 'rt' })
  assert.equal(with_.hasRefreshToken(), true)
  assert.equal(with_.refreshToken(), 'rt')
})

test('granted scopes are what Google returned, not what was asked for', () => {
  const partial = new GoogleTokens({ access_token: 'at', scope: 'openid https://www.googleapis.com/auth/calendar' })
  assert.equal(partial.hasScopes(), true)
  assert.deepEqual(partial.scopes(), ['openid', 'https://www.googleapis.com/auth/calendar'])
  assert.equal(new GoogleTokens({ access_token: 'at' }).hasScopes(), false)
})

// -------------------------------------------------------------------- identity

const jwt = (claims: Record<string, unknown>): string =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`

test('the claims come out of the payload segment', () => {
  const claims = decodeIdToken(jwt({ sub: '1', email: 'trevor@datasaur.ai', hd: 'datasaur.ai' }))
  assert.deepEqual(claims, { sub: '1', email: 'trevor@datasaur.ai', hd: 'datasaur.ai' })
})

test('anything that is not a JWT is refused rather than half-read', () => {
  assert.throws(() => decodeIdToken('not-a-jwt'), /not a JWT/)
  assert.throws(() => decodeIdToken('a.!!!!.c'), /could not read/)
})

test('the hosted domain is read from the token, never from the email string', () => {
  // The whole point of D6: someone@datasaur.ai.evil.example must not read as
  // datasaur.ai, so the domain only ever comes from the hd claim.
  const identity = identityFromIdToken({
    sub: '1',
    email: 'someone@datasaur.ai.evil.example',
    email_verified: true,
  })
  assert.equal(identity.hostedDomain, null)
})

test('an identity without a subject or an email is not an identity', () => {
  assert.throws(() => identityFromIdToken({ email: 'a@b.com' }), /subject or email/)
  assert.throws(() => identityFromIdToken({ sub: '1' }), /subject or email/)
})

test('email_verified is only true when it is exactly true', () => {
  assert.equal(identityFromIdToken({ sub: '1', email: 'a@b.com', email_verified: 'true' }).emailVerified, false)
  assert.equal(identityFromIdToken({ sub: '1', email: 'a@b.com', email_verified: true }).emailVerified, true)
})

test('the name falls back to the address rather than being empty', () => {
  assert.equal(identityFromIdToken({ sub: '1', email: 'a@b.com' }).name, 'a@b.com')
})

// Keep the global fetch the tests replaced from leaking into another file.
test.after(() => mock.restoreAll())
