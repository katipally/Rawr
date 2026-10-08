import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUDIT_TARGETS } from '@rawr/db/audit-targets'
import { actionOf, categoryOf, fieldOf } from './audit-labels.ts'

test('past tense follows the verb, not only the common endings', () => {
  assert.equal(actionOf('copy_grants'), 'Copied grants')
  assert.equal(actionOf('carry_over'), 'Carried over')
  assert.equal(actionOf('delay_send'), 'Delayed send')
  assert.equal(actionOf('send_message'), 'Sent message')
  assert.equal(actionOf('set_grants'), 'Set grants')
  assert.equal(actionOf('save_steps'), 'Saved steps')
  assert.equal(actionOf('enroll'), 'Enrolled')
  assert.equal(actionOf('roll_secret'), 'Rolled secret')
  assert.equal(actionOf('retry_index'), 'Retried index')
  assert.equal(actionOf('wait_for_task'), 'Waited for task')
  assert.equal(actionOf('store_body'), 'Stored body')
})

test('an action whose first word is not its verb reads as a whole phrase', () => {
  assert.equal(actionOf('send_failed'), 'Failed to send')
  assert.equal(actionOf('call'), 'Logged a call')
  assert.equal(actionOf('booking'), 'Booked')
  assert.equal(actionOf('stage_change'), 'Changed the stage')
  assert.equal(actionOf('conference-link'), 'Added a conference link')
})

test('every audited entity has a category name that reads as a sentence', () => {
  for (const entity of Object.keys(AUDIT_TARGETS)) {
    assert.match(categoryOf(entity), /^[A-Z][A-Za-z ]*$/, entity)
  }
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
