import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionOf, categoryOf, fieldOf } from './audit-labels.ts'

test('past tense follows the verb, not only the common endings', () => {
  assert.equal(actionOf('copy_grants'), 'Copied grants')
  assert.equal(actionOf('carry_over'), 'Carried over')
  assert.equal(actionOf('delay_send'), 'Delayed send')
  assert.equal(actionOf('send_message'), 'Sent message')
  assert.equal(actionOf('set_grants'), 'Set grants')
  assert.equal(actionOf('save_steps'), 'Saved steps')
})

test('category names read as words, with the terms the app spells in capitals', () => {
  assert.equal(categoryOf('mcp_token'), 'MCP token')
  assert.equal(categoryOf('field_def'), 'Field definition')
  assert.equal(categoryOf('import_run'), 'Import run')
  assert.equal(categoryOf('contact'), 'Contact')
  assert.equal(categoryOf('oauth_grant'), 'OAuth grant')
})

test('changed field keys read as words', () => {
  assert.equal(fieldOf('reassignedTo'), 'reassigned to')
  assert.equal(fieldOf('first_name'), 'first name')
  assert.equal(fieldOf('state'), 'state')
})
