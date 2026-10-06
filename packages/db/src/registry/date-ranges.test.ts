import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DATE_RANGES, isDateRange, resolveDateRange, type DateRangeToken } from './date-ranges.ts'

// Wednesday 2026-10-07, in the year's last quarter.
const today = '2026-10-07'

test('each range is its first and last day, both inclusive', () => {
  const cases: Partial<Record<DateRangeToken, [string, string]>> = {
    '@today': ['2026-10-07', '2026-10-07'],
    '@yesterday': ['2026-10-06', '2026-10-06'],
    '@this_week': ['2026-10-05', '2026-10-11'],
    '@this_week_so_far': ['2026-10-05', '2026-10-07'],
    '@last_week': ['2026-09-28', '2026-10-04'],
    '@next_month': ['2026-11-01', '2026-11-30'],
    '@last_quarter': ['2026-07-01', '2026-09-30'],
    '@next_quarter': ['2027-01-01', '2027-03-31'],
    '@last_year': ['2025-01-01', '2025-12-31'],
    '@this_year_so_far': ['2026-01-01', '2026-10-07'],
    '@last_7_days': ['2026-09-30', '2026-10-06'],
  }
  for (const [token, span] of Object.entries(cases)) {
    assert.ok(isDateRange(token), token)
    assert.deepEqual(resolveDateRange(token as DateRangeToken, today), span, token)
  }
})

test('a month boundary and a leap day land on the right calendar day', () => {
  assert.deepEqual(resolveDateRange('@last_month', '2024-03-31'), ['2024-02-01', '2024-02-29'])
  assert.deepEqual(resolveDateRange('@this_week', '2026-01-01'), ['2025-12-29', '2026-01-04'])
})

test('only the listed tokens are ranges, and every one resolves in order', () => {
  assert.equal(isDateRange('@last_8_days'), false)
  assert.equal(isDateRange('2026-10-07'), false)
  for (const range of DATE_RANGES) {
    const [first, last] = resolveDateRange(range.token, today)
    assert.ok(first <= last, range.token)
  }
})
