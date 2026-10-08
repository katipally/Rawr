import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lastPageStart } from './page-offset.ts'

test('an empty list starts at zero', () => {
  assert.equal(lastPageStart(0, 25), 0)
})

test('one short page starts at zero', () => {
  assert.equal(lastPageStart(1, 25), 0)
  assert.equal(lastPageStart(25, 25), 0)
})

test('the last page starts at the first row of its page', () => {
  assert.equal(lastPageStart(26, 25), 25)
  assert.equal(lastPageStart(50, 25), 25)
  assert.equal(lastPageStart(51, 25), 50)
})
