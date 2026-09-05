import assert from 'node:assert/strict'
import { test } from 'node:test'
import { originFrom } from './origin.ts'

const from = (headers: Record<string, string>) =>
  originFrom((name) => headers[name.toLowerCase()] ?? null)

test('the host the client reached is the origin it is told about', () => {
  assert.equal(from({ host: 'rawr.acme.com' }), 'https://rawr.acme.com')
})

test('a loopback host keeps http, so development needs no configuration', () => {
  assert.equal(from({ host: 'localhost:3000' }), 'http://localhost:3000')
  assert.equal(from({ host: '127.0.0.1:3000' }), 'http://127.0.0.1:3000')
})

test('a proxy that terminates TLS is believed about the scheme', () => {
  assert.equal(
    from({ host: 'internal:8080', 'x-forwarded-host': 'rawr.acme.com', 'x-forwarded-proto': 'https' }),
    'https://rawr.acme.com',
  )
})

test('only the hop we run is read, so a caller cannot prepend its own host', () => {
  // One trusted hop by default: the last entry is the one our proxy appended.
  assert.equal(
    from({ host: 'internal', 'x-forwarded-host': 'evil.example, rawr.acme.com' }),
    'https://rawr.acme.com',
  )
})

test('a host that is not a host is refused rather than concatenated', () => {
  for (const host of ['rawr.acme.com/evil', 'http://rawr.acme.com', 'a b', '']) {
    assert.equal(from({ host }), 'http://localhost:3000', `refused: ${host}`)
  }
})
