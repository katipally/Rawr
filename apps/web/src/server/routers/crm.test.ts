import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordUpdateInput } from './crm-input.ts'

const id = '6f1c2b1e-4d2a-4c1b-9b8e-2f3a4b5c6d7e'
const base = { object: 'contact', id, values: { title: 'mine' } }

test('an inline save names the value it read and no record stamp', () => {
  const parsed = recordUpdateInput.parse({ ...base, expectedValues: { title: null } })
  assert.deepEqual(parsed.expectedValues, { title: null })
  assert.equal(parsed.expectedUpdatedAt, undefined)
})

test('a caller that sends the record stamp still gets a date', () => {
  const parsed = recordUpdateInput.parse({ ...base, expectedUpdatedAt: '2026-10-07T20:06:14.805Z' })
  assert.equal(parsed.expectedUpdatedAt?.toISOString(), '2026-10-07T20:06:14.805Z')
})

test('a stamp that is not a date is refused with a sentence', () => {
  const failed = recordUpdateInput.safeParse({ ...base, expectedUpdatedAt: 'yesterday' })
  assert.equal(failed.success, false)
  assert.equal(failed.error?.issues[0]?.message, 'That is not a date.')
})
