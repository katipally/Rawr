import assert from 'node:assert/strict'
import { test } from 'node:test'
import { moveKey } from './card-order.ts'

test('a card moves one place earlier or later', () => {
  assert.deepEqual(moveKey(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c'])
  assert.deepEqual(moveKey(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b'])
})

test('a card at either end cannot move past it, and the same list comes back', () => {
  const keys = ['a', 'b']
  assert.equal(moveKey(keys, 0, -1), keys)
  assert.equal(moveKey(keys, 1, 1), keys)
})

test('a single card and an empty list stay as they are', () => {
  assert.deepEqual(moveKey(['a'], 0, 1), ['a'])
  assert.deepEqual(moveKey([], 0, 1), [])
})

test('the list it is given is not changed', () => {
  const keys = ['a', 'b', 'c']
  moveKey(keys, 0, 2)
  assert.deepEqual(keys, ['a', 'b', 'c'])
})
