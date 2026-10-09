import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boldPressed } from './bold-mark.ts'

test('bold reads as on when the browser says so or the caret is inside a bold element', () => {
  assert.equal(boldPressed(true, false), true)
  assert.equal(boldPressed(false, true), true)
  assert.equal(boldPressed(true, true), true)
  assert.equal(boldPressed(false, false), false)
})
