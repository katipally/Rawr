import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { isCredentialRejection, isRateLimited, sendWithBackoff } from './provider.ts'

/** What a provider's "slow down" must not be mistaken for, and what it must be
 *  waited out as. */

const answers = (...queue: Response[]) => {
  let calls = 0
  return { send: async () => queue[Math.min(calls++, queue.length - 1)] as Response, calls: () => calls }
}
const reply = (status: number, body = '', headers: Record<string, string> = {}) =>
  new Response(body, { status, headers })

test('a 429 is waited out for as long as Retry-After says, then repeated', async () => {
  const { send, calls } = answers(reply(429, '', { 'retry-after': '1' }), reply(200, '{}'))
  const started = Date.now()
  const response = await sendWithBackoff(send)
  assert.equal(response.status, 200)
  assert.equal(calls(), 2)
  assert.ok(Date.now() - started >= 900)
})

test('Google reports a quota as a 403, and that is repeated too', async () => {
  const quota = '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}'
  const { send, calls } = answers(reply(403, quota, { 'retry-after': '1' }), reply(200, '{}'))
  assert.equal((await sendWithBackoff(send)).status, 200)
  assert.equal(calls(), 2)
})

test('a 403 that is a refusal is returned at once', async () => {
  const { send, calls } = answers(reply(403, '{"error":{"errors":[{"reason":"forbidden"}]}}'))
  assert.equal((await sendWithBackoff(send)).status, 403)
  assert.equal(calls(), 1)
})

test('a 5xx is repeated only for a request that is safe to repeat', async () => {
  const unsafe = answers(reply(503), reply(200))
  assert.equal((await sendWithBackoff(unsafe.send)).status, 503)
  assert.equal(unsafe.calls(), 1)

  const safe = answers(reply(503), reply(200))
  assert.equal((await sendWithBackoff(safe.send, { repeatable: true })).status, 200)
  assert.equal(safe.calls(), 2)
})

test('a wait too long to hold a request open is handed back, not slept through', async () => {
  const { send, calls } = answers(reply(429, '', { 'retry-after': '3600' }), reply(200))
  const started = Date.now()
  assert.equal((await sendWithBackoff(send)).status, 429)
  assert.equal(calls(), 1)
  assert.ok(Date.now() - started < 500)
})

test('the number of tries is finite', async () => {
  const { send, calls } = answers(reply(429, '', { 'retry-after': '1' }))
  mock.timers.enable({ apis: ['setTimeout'] })
  const done = sendWithBackoff(send, { attempts: 3 })
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    mock.timers.tick(1000)
  }
  assert.equal((await done).status, 429)
  assert.equal(calls(), 3)
  mock.timers.reset()
})

test('a quota is not a rejected credential, and a bad key still is', () => {
  assert.equal(isRateLimited(429, ''), true)
  assert.equal(isRateLimited(403, 'rateLimitExceeded'), true)
  assert.equal(isCredentialRejection(403, 'userRateLimitExceeded'), false)
  assert.equal(isCredentialRejection(403, 'forbidden'), true)
  assert.equal(isCredentialRejection(401), true)
  assert.equal(isCredentialRejection(429), false)
})
