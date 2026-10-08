import assert from 'node:assert/strict'
import { test } from 'node:test'
import { messageFrameSandbox } from './message-frame.ts'

test('a mail frame never runs script and never opens a window itself', () => {
  const tokens = messageFrameSandbox.split(' ')
  assert.ok(!tokens.includes('allow-scripts'))
  assert.ok(!tokens.includes('allow-popups'))
  assert.ok(!tokens.includes('allow-popups-to-escape-sandbox'))
})
