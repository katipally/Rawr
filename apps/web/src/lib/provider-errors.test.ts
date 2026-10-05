import assert from 'node:assert/strict'
import { test } from 'node:test'
import { plainError } from './provider-errors.ts'

test('a provider code becomes a sentence that says what to do', () => {
  assert.match(plainError('invalid_grant: Bad Request') ?? '', /Reconnect it/)
  assert.match(plainError('slack.form-submission: Slack refused the message: not_in_channel.') ?? '', /Invite the bot/)
  assert.match(plainError('Slack refused the message: missing_scope.') ?? '', /chat:write/)
})

test('text with no known code is left to the caller', () => {
  assert.equal(plainError('Brevo answered 502'), null)
  assert.equal(plainError(''), null)
})
