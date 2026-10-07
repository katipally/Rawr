import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crossOrigin } from './same-origin.ts'

const own = 'https://rawr.acme.com'
const post = (origin?: string) =>
  new Request(`${own}/api/auth/sign-out`, { method: 'POST', headers: origin === undefined ? {} : { origin } })

test('the same origin passes', () => {
  assert.equal(crossOrigin(post(own), own), false)
})

test('another site, another port or another scheme is cross-origin', () => {
  assert.equal(crossOrigin(post('https://evil.example'), own), true)
  assert.equal(crossOrigin(post('https://rawr.acme.com:8443'), own), true)
  assert.equal(crossOrigin(post('http://rawr.acme.com'), own), true)
})

test('a sandboxed frame sends the string null and is refused', () => {
  assert.equal(crossOrigin(post('null'), own), true)
})

test('no Origin header is a non-browser client and passes', () => {
  assert.equal(crossOrigin(post(), own), false)
})
