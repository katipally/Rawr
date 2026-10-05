import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostMailbox } from './booking-mail.ts'

const box = (userId: string, canSend = true, state = 'connected') => ({ userId, canSend, state })

test('a meeting mail goes out of the host\'s own mailbox', () => {
  const own = box('yash')
  assert.equal(hostMailbox([box('andika'), own], 'yash'), own)
})

test('with no mailbox of the host\'s that can send, a colleague\'s is never borrowed', () => {
  assert.equal(hostMailbox([box('andika'), box('yash', false)], 'yash'), undefined)
  assert.equal(hostMailbox([box('andika'), box('yash', true, 'revoked')], 'yash'), undefined)
  assert.equal(hostMailbox([box('andika')], 'yash'), undefined)
})
