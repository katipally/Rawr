import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isMissingObject } from './attachment-sweep.ts'

test('a delete of a key that is already gone counts as deleted', () => {
  assert.equal(isMissingObject(Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' })), true)
  assert.equal(isMissingObject({ $metadata: { httpStatusCode: 404 } }), true)
})

test('any other storage failure is kept, so the row survives for the next pass', () => {
  assert.equal(isMissingObject(Object.assign(new Error('Access Denied'), { name: 'AccessDenied' })), false)
  assert.equal(isMissingObject({ $metadata: { httpStatusCode: 503 } }), false)
  assert.equal(isMissingObject(new Error('socket hang up')), false)
  assert.equal(isMissingObject(null), false)
  assert.equal(isMissingObject('NoSuchKey'), false)
})
