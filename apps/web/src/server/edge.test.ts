import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NextRequest } from 'next/server'
import { bodyRefusal, clientIpFrom, corsPreflight, MAX_BODY_BYTES, PayloadTooLarge, readBody, readRaw, UnreadableBody, unverified, withCors } from './edge.ts'

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

const post = (body: string, type: string): NextRequest =>
  new Request('http://localhost/f/x', { method: 'POST', headers: { 'content-type': type }, body }) as NextRequest

test('a JSON object body is read as it was sent', async () => {
  assert.deepEqual(await readBody(post('{"first_name":"Ada","tags":["a","b"]}', 'application/json')), { first_name: 'Ada', tags: ['a', 'b'] })
})

test('a body that is not JSON is unreadable rather than an empty answer set', async () => {
  await assert.rejects(readBody(post('not json{', 'application/json')), UnreadableBody)
  await assert.rejects(readBody(post('', 'application/json; charset=utf-8')), UnreadableBody)
})

test('JSON that is not an object is unreadable', async () => {
  for (const text of ['[1,2]', 'null', '"text"', '7', 'true']) {
    await assert.rejects(readBody(post(text, 'application/json')), UnreadableBody, text)
  }
})

test('a form-encoded body still reads, with repeated keys as a list', async () => {
  assert.deepEqual(await readBody(post('a=1&b=x&b=y&c=', 'application/x-www-form-urlencoded')), { a: '1', b: ['x', 'y'], c: '' })
})

test('an oversized body is refused whatever its type', async () => {
  await assert.rejects(readBody(post('x'.repeat(MAX_BODY_BYTES + 1), 'application/json')), PayloadTooLarge)
})

test('a refused body is 413 when too large and 400 otherwise', () => {
  assert.equal(bodyRefusal(new PayloadTooLarge()).status, 413)
  assert.equal(bodyRefusal(new UnreadableBody()).status, 400)
  assert.equal(bodyRefusal(new Error('x')).status, 400)
})

/** A body that arrives in 1 KB chunks with no content-length, as a chunked upload
 *  does, counting how many chunks the reader actually pulled. */
const chunked = (chunks: number) => {
  let pulled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) return controller.close()
      pulled += 1
      controller.enqueue(new Uint8Array(1024).fill(97))
    },
  })
  const request = new Request('http://localhost/w/webflow', { method: 'POST', body: stream, duplex: 'half' } as RequestInit) as NextRequest
  return { request, pulled: () => pulled }
}

test('a chunked body over the cap is cut off without being read to the end', async () => {
  const { request, pulled } = chunked(100_000)
  await assert.rejects(readRaw(request), PayloadTooLarge)
  assert.ok(pulled() <= MAX_BODY_BYTES / 1024 + 2, `pulled ${pulled()} chunks`)
})

test('a body of exactly the cap is read whole and an empty one is empty text', async () => {
  assert.equal((await readRaw(chunked(MAX_BODY_BYTES / 1024).request)).length, MAX_BODY_BYTES)
  assert.equal(await readRaw(new Request('http://localhost/w/x', { method: 'POST' }) as NextRequest), '')
})

test('a declared length over the cap is refused before any byte is read', async () => {
  const request = new Request('http://localhost/w/x', { method: 'POST', headers: { 'content-length': String(MAX_BODY_BYTES + 1) }, body: 'x' }) as NextRequest
  await assert.rejects(readRaw(request), PayloadTooLarge)
})

test('multi-byte text under the byte cap survives the stream join', async () => {
  const text = 'é'.repeat(1000)
  assert.equal(await readRaw(post(text, 'text/plain')), text)
})

test('every unverifiable inbound request gets the same 401 whatever the reason', async () => {
  const a = unverified('/w/brevo', 'provider not connected')
  const b = unverified('/w/webflow', 'signature mismatch')
  assert.equal(a.status, 401)
  assert.equal(b.status, 401)
  assert.deepEqual(await a.json(), await b.json())
})

test('a preflight for a bearer endpoint answers 204, any origin, with the headers a browser client sends', () => {
  const answer = corsPreflight('POST, OPTIONS')
  assert.equal(answer.status, 204)
  assert.equal(answer.headers.get('access-control-allow-origin'), '*')
  assert.equal(answer.headers.get('access-control-allow-methods'), 'POST, OPTIONS')
  for (const header of ['authorization', 'content-type', 'mcp-protocol-version']) {
    assert.ok(answer.headers.get('access-control-allow-headers')?.includes(header), header)
  }
  assert.equal(answer.headers.get('access-control-allow-credentials'), null)
})

test('an answer through withCors carries the origin and exposes the headers a refusal needs, errors included', () => {
  const refused = withCors(Response.json({ error: 'x' }, { status: 429, headers: { 'retry-after': '60' } }))
  assert.equal(refused.status, 429)
  assert.equal(refused.headers.get('access-control-allow-origin'), '*')
  assert.ok(refused.headers.get('access-control-expose-headers')?.includes('retry-after'))
})
