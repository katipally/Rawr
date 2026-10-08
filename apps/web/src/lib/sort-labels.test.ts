import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstDirection, sortWords } from './sort-labels.ts'

test('a text property reads its directions as A to Z and Z to A', () => {
  assert.deepEqual(sortWords('text'), { asc: 'A to Z', desc: 'Z to A' })
  assert.deepEqual(sortWords('email'), { asc: 'A to Z', desc: 'Z to A' })
})

test('a date reads its directions as oldest and most recent, never as A to Z', () => {
  assert.deepEqual(sortWords('datetime'), { asc: 'Oldest first', desc: 'Most recent' })
  assert.deepEqual(sortWords('date'), { asc: 'Oldest first', desc: 'Most recent' })
})

test('a number reads its directions as low to high and high to low', () => {
  assert.deepEqual(sortWords('currency'), { asc: 'Low to high', desc: 'High to low' })
  assert.deepEqual(sortWords('number'), { asc: 'Low to high', desc: 'High to low' })
})

test('a text property is first sorted A to Z, a date or number from the top', () => {
  assert.equal(firstDirection('text'), 'asc')
  assert.equal(firstDirection('select'), 'asc')
  assert.equal(firstDirection('datetime'), 'desc')
  assert.equal(firstDirection('number'), 'desc')
})
