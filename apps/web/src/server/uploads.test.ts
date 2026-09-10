import assert from 'node:assert/strict'
import { test } from 'node:test'
import { declaredTooLarge, readCapped } from './uploads.ts'

/** The cap is the only thing standing between an upload endpoint and this
 *  process's memory, so it has to hold against a request that lies about its
 *  size in either direction. */

const CAP = 1024

const sending = (body: BodyInit | null, headers: Record<string, string> = {}): Request =>
  new Request('http://localhost/api/attachments/upload', { method: 'POST', body, headers })

test('a declared size over the cap is refused before a byte is read', () => {
  assert.equal(declaredTooLarge('2048', CAP), true)
  assert.equal(declaredTooLarge('1024', CAP), false)
})

test('no declared size at all is not a refusal on its own', () => {
  assert.equal(declaredTooLarge(null, CAP), false)
  assert.equal(declaredTooLarge('not a number', CAP), false)
})

test('a file inside the cap arrives whole', async () => {
  const body = await readCapped(sending(new Uint8Array(CAP).fill(7)), CAP)
  assert.equal(body?.byteLength, CAP)
  assert.equal(body?.[0], 7)
  assert.equal(body?.[CAP - 1], 7)
})

test('a body that under-declares is still refused, by counting it', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let sent = 0; sent < CAP * 4; sent += CAP) controller.enqueue(new Uint8Array(CAP))
      controller.close()
    },
  })
  const lying = new Request('http://localhost/api/attachments/upload', {
    method: 'POST',
    body: stream,
    headers: { 'content-length': '8' },
    // @ts-expect-error the runtime needs this for a streamed body; the DOM types
    // for Request have no field for it.
    duplex: 'half',
  })
  assert.equal(await readCapped(lying, CAP), null)
})

test('an empty request reads as no bytes rather than as a refusal', async () => {
  const body = await readCapped(sending(null), CAP)
  assert.equal(body?.byteLength, 0)
})
