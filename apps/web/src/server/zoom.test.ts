import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zoomRefusalMessage } from './zoom.ts'

/** The body Zoom's token endpoint answers a wrong client id or secret with. */
const INVALID_CLIENT = '{"reason":"Invalid client_id or client_secret","error":"invalid_client"}'

test('a wrong client id or secret gets a sentence a person can act on', () => {
  assert.equal(zoomRefusalMessage(INVALID_CLIENT), 'Zoom rejected the client ID or secret.')
})

test('a body with no known code gets the safe fallback, never the raw text', () => {
  for (const body of ['', 'not json at all', 'null', '{"code":124,"message":"Invalid access token."}']) {
    const message = zoomRefusalMessage(body)
    assert.equal(message, 'Zoom refused the request. Try again, or test the connection.')
    assert.ok(!message.includes('{') && !message.includes('Invalid access token'), message)
  }
})

test('the raw provider JSON never reaches the message', () => {
  assert.ok(!zoomRefusalMessage(INVALID_CLIENT).includes('invalid_client'))
  assert.ok(!zoomRefusalMessage(INVALID_CLIENT).includes('{'))
})
