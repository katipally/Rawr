import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rangeFrom } from './range.ts'

test('a range longer than the reports cover is cut to its most recent year and says so', () => {
  const range = rangeFrom({ from: '2024-01-01', to: '2026-10-07' }, 'UTC')
  assert.equal(range.clipped, true)
  assert.equal(range.fromDay, '2025-10-07')
  assert.equal(range.toDay, '2026-10-07')
})

test('a range of exactly the covered length is not reported as cut', () => {
  const range = rangeFrom({ from: '2025-10-07', to: '2026-10-07' }, 'UTC')
  assert.equal(range.clipped, false)
  assert.equal(range.fromDay, '2025-10-07')
})
