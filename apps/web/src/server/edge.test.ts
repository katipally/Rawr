import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clientIpFrom } from './edge.ts'

/** TRUSTED_PROXY_HOPS defaults to 1, which is the deployment: one reverse proxy
 *  in front of the app. */

const from = (headers: Record<string, string>) =>
  clientIpFrom((name) => headers[name.toLowerCase()] ?? null)

test('the address our own proxy appended is the client address', () => {
  assert.equal(from({ 'x-forwarded-for': '203.0.113.7' }), '203.0.113.7')
})

test('a forged left entry is ignored, so it cannot buy a fresh rate-limit bucket', () => {
  // Two callers sending different left entries through the same proxy must land
  // on the same address, or the per-IP submit limits stop meaning anything.
  const one = from({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })
  const two = from({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' })
  assert.equal(one, '203.0.113.7')
  assert.equal(two, '203.0.113.7')
})

test('spacing and empty entries in the header do not shift which hop is read', () => {
  assert.equal(from({ 'x-forwarded-for': ' 1.1.1.1 ,, 203.0.113.7 ' }), '203.0.113.7')
})

test('x-real-ip answers only when there is no forwarded chain', () => {
  assert.equal(from({ 'x-real-ip': '203.0.113.9' }), '203.0.113.9')
  assert.equal(from({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7', 'x-real-ip': '9.9.9.9' }), '203.0.113.7')
})

test('no headers at all is no address rather than a made-up one', () => {
  assert.equal(from({}), null)
})
