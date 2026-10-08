import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pickable } from './pickable.ts'

const choices = [
  { id: 'ana', label: 'Ana', deactivated: false },
  { id: 'ben', label: 'Ben', deactivated: true },
  { id: 'cy', label: 'Cy' },
]

test('a deactivated member is not offered', () => {
  assert.deepEqual(pickable(choices, null).map((choice) => choice.id), ['ana', 'cy'])
})

test('a deactivated member stays offered while a record points at them', () => {
  assert.deepEqual(pickable(choices, 'ben').map((choice) => choice.id), ['ana', 'ben', 'cy'])
})

test('an empty list stays empty', () => {
  assert.deepEqual(pickable([], 'ben'), [])
})
