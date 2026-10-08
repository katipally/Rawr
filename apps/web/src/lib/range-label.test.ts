import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFormat } from './format.ts'
import { rangeLabel } from './range-label.ts'

const fmt = createFormat({ locale: 'en-US', zone: 'UTC', currency: 'USD' })
const today = '2026-10-07'
const label = (from: string, to: string, now = today) => rangeLabel(from, to, now, fmt)

test('a single day in this year is one date, not "Oct 7 to Oct 7"', () => {
  assert.equal(label('2026-10-07', '2026-10-07'), 'Oct 7')
})

test('a range inside this year drops the year from both ends', () => {
  assert.equal(label('2026-10-01', '2026-10-07'), 'Oct 1 to Oct 7')
})

test('a range across months in this year still drops the year', () => {
  assert.equal(label('2026-09-28', '2026-10-07'), 'Sep 28 to Oct 7')
})

test('a range in a past year writes the year on both ends', () => {
  assert.equal(label('2025-10-01', '2025-10-07'), 'Oct 1, 2025 to Oct 7, 2025')
})

test('a single day in a past year keeps its year', () => {
  assert.equal(label('2025-10-07', '2025-10-07'), 'Oct 7, 2025')
})

test('a range across New Year writes the year on both ends', () => {
  assert.equal(label('2025-12-30', '2026-01-05'), 'Dec 30, 2025 to Jan 5, 2026')
})

test('a range in a future year keeps its year', () => {
  assert.equal(label('2027-01-02', '2027-01-05'), 'Jan 2, 2027 to Jan 5, 2027')
})

test('the year that counts as this year is the one the viewer is in', () => {
  assert.equal(label('2026-01-03', '2026-01-03', '2027-01-03'), 'Jan 3, 2026')
})
