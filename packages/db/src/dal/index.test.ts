import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isUuid } from './index.ts'

test('isUuid accepts a canonical uuid in either case', () => {
  assert.equal(isUuid('b0000000-0000-0000-0000-000000000001'), true)
  assert.equal(isUuid('B0000000-00AA-0000-0000-00000000ABCD'), true)
})

test('isUuid rejects a slug, a truncated uuid, and empty text before Postgres sees it', () => {
  assert.equal(isUuid('does-not-exist'), false)
  assert.equal(isUuid('b0000000-0000-0000-0000-00000000000'), false)
  assert.equal(isUuid('b0000000-0000-0000-0000-000000000001 '), false)
  assert.equal(isUuid(''), false)
})
