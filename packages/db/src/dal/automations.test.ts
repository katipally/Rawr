import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSettableField } from './automations.ts'

const field = (key: string, type: string, isSystem = false) => ({ key, type, isSystem })

test('a rule can set a field whose type a single value fills', () => {
  for (const type of ['text', 'long_text', 'email', 'phone', 'url', 'linkedin', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean', 'select']) {
    assert.equal(isSettableField(field('title', type)), true, type)
  }
})

test('a rule cannot set a field that needs an id, a shape or a list', () => {
  for (const type of ['relation', 'user', 'rating', 'json', 'address', 'rich_text', 'multi_select']) {
    assert.equal(isSettableField(field('title', type)), false, type)
  }
})

test('a system field and marketing status are never settable', () => {
  assert.equal(isSettableField(field('created_at', 'datetime', true)), false)
  assert.equal(isSettableField(field('marketing_status', 'select')), false)
})
