import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cronFor, dayKeyUtc, isOverdue, lastOccurrence, type DailyAt } from './catch-up.ts'

/** The predicate that decides whether a sleeping container missed its nightly
 *  work. Wrong one way, the roll-up never runs; wrong the other, it runs on every
 *  restart all day. */

const rollUp: DailyAt = { hourUtc: 3, minuteUtc: 30 }
const at = (iso: string) => new Date(iso)

test('the cron string and the time asked about are the same time', () => {
  assert.equal(cronFor(rollUp), '30 3 * * *')
  assert.equal(cronFor({ hourUtc: 7, minuteUtc: 0 }), '0 7 * * *')
})

test('after the hour, the occurrence is today', () => {
  assert.equal(lastOccurrence(at('2026-09-09T09:00:00Z'), rollUp).toISOString(), '2026-09-09T03:30:00.000Z')
})

test('before it, the occurrence is yesterday', () => {
  assert.equal(lastOccurrence(at('2026-09-09T01:00:00Z'), rollUp).toISOString(), '2026-09-08T03:30:00.000Z')
})

test('exactly on it counts as today', () => {
  assert.equal(lastOccurrence(at('2026-09-09T03:30:00Z'), rollUp).toISOString(), '2026-09-09T03:30:00.000Z')
})

test('a month boundary goes back a day, not to the first of the month', () => {
  assert.equal(lastOccurrence(at('2026-10-01T02:00:00Z'), rollUp).toISOString(), '2026-09-30T03:30:00.000Z')
})

test('never run at all is overdue', () => {
  assert.equal(isOverdue(null, at('2026-09-09T03:30:00Z')), true)
})

test('run since the occurrence is not overdue, run before it is', () => {
  const occurrence = at('2026-09-09T03:30:00Z')
  assert.equal(isOverdue(at('2026-09-09T03:30:01Z'), occurrence), false)
  assert.equal(isOverdue(at('2026-09-08T03:30:05Z'), occurrence), true)
})

test('the key is the day of the occurrence, so two restarts in one morning queue one job', () => {
  const morning = lastOccurrence(at('2026-09-09T06:00:00Z'), rollUp)
  const later = lastOccurrence(at('2026-09-09T09:00:00Z'), rollUp)
  assert.equal(dayKeyUtc(morning), '2026-09-09')
  assert.equal(dayKeyUtc(later), dayKeyUtc(morning))
})

test('either side of midnight is still the same missed night, because the key is the occurrence', () => {
  const before = lastOccurrence(at('2026-09-09T23:59:00Z'), rollUp)
  const after = lastOccurrence(at('2026-09-10T00:01:00Z'), rollUp)
  assert.equal(dayKeyUtc(before), '2026-09-09')
  assert.equal(dayKeyUtc(after), '2026-09-09')
})
