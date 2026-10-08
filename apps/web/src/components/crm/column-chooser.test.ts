import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooserRows, withNameParts } from './column-chooser.ts'

test('a first and last name the table shows as Name is one chooser row', () => {
  assert.deepEqual(chooserRows(['email', 'first_name', 'last_name']), ['email', 'first_name'])
  assert.deepEqual(chooserRows(['last_name', 'email']), ['last_name', 'email'])
})

test('naming the Name row carries its last name, and a row is never doubled', () => {
  assert.deepEqual(withNameParts(['email', 'first_name']), ['email', 'first_name', 'last_name'])
  assert.deepEqual(withNameParts(['last_name', 'first_name']), ['last_name', 'first_name'])
  assert.deepEqual(withNameParts(['email', 'phone']), ['email', 'phone'])
})

test('moving the Name row keeps its last name with it', () => {
  const rows = chooserRows(['email', 'first_name', 'last_name', 'phone'])
  const moved = [rows[1]!, rows[0]!, rows[2]!]
  assert.deepEqual(withNameParts(moved), ['first_name', 'last_name', 'email', 'phone'])
})
