import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import type { McpClientRow } from '@rawr/db'
import { pkceMatches, redirectAcceptable, redirectAllowed } from './oauth.ts'

/** PKCE and the redirect allowlist are the two checks standing between an
 *  authorization code and somebody else's CRM. */

const client = (uris: string[]): McpClientRow =>
  ({ id: 'c', name: 'A client', redirectUris: uris, source: 'dcr', fetchedAt: null }) as McpClientRow

const challengeFor = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

test('a correct verifier matches its challenge', () => {
  const verifier = randomBytes(32).toString('base64url')
  assert.ok(pkceMatches(verifier, challengeFor(verifier)))
})

test('a wrong verifier does not', () => {
  const verifier = randomBytes(32).toString('base64url')
  assert.equal(pkceMatches(randomBytes(32).toString('base64url'), challengeFor(verifier)), false)
})

test('a verifier outside RFC 7636 length is refused before it is hashed', () => {
  const short = 'a'.repeat(42)
  const long = 'a'.repeat(129)
  assert.equal(pkceMatches(short, challengeFor(short)), false)
  assert.equal(pkceMatches(long, challengeFor(long)), false)
  // The boundaries themselves are legal.
  const min = 'a'.repeat(43)
  const max = 'a'.repeat(128)
  assert.ok(pkceMatches(min, challengeFor(min)))
  assert.ok(pkceMatches(max, challengeFor(max)))
})

test('plain PKCE is never accepted as if it were S256', () => {
  const verifier = 'a'.repeat(43)
  assert.equal(pkceMatches(verifier, verifier), false)
})

test('only https, or http on a loopback address, may receive a code', () => {
  for (const ok of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:9321/cb', 'http://127.0.0.1:1/cb']) {
    assert.ok(redirectAcceptable(ok), ok)
  }
  for (const bad of ['http://evil.example/cb', 'ftp://x/cb', 'not a url', '', 'http://localhost.evil.example/cb']) {
    assert.equal(redirectAcceptable(bad), false, bad)
  }
})

test('a registered redirect matches exactly', () => {
  const c = client(['https://claude.ai/cb'])
  assert.ok(redirectAllowed(c, 'https://claude.ai/cb'))
  for (const bad of ['https://claude.ai/cb2', 'https://claude.ai/cb?x=1', 'https://evil.example/cb']) {
    assert.equal(redirectAllowed(c, bad), false, bad)
  }
})

test('a loopback redirect matches on any port, and only on the same path', () => {
  // RFC 8252 §7.3: a native client binds an ephemeral port per session.
  const c = client(['http://127.0.0.1:1234/callback'])
  assert.ok(redirectAllowed(c, 'http://127.0.0.1:56789/callback'))
  assert.equal(redirectAllowed(c, 'http://127.0.0.1:56789/other'), false)
  assert.equal(redirectAllowed(c, 'http://localhost:56789/callback'), false, 'a different host is a different client')
})

test('the port wildcard never extends to a remote host', () => {
  const c = client(['https://claude.ai/cb'])
  assert.equal(redirectAllowed(c, 'https://claude.ai:8443/cb'), false)
})
