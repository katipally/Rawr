import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addDays, dayKey, scheduleProblem, slotInWindow, windowProblem } from './slots.ts'

const now = new Date('2026-10-07T12:00:00Z')
const page = { minNoticeMinutes: 240, maxHorizonDays: 30 }
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000)

test('a time in the past or right now is refused', () => {
  assert.equal(slotInWindow(page, new Date('2020-01-01T00:00:00Z'), now), false)
  assert.equal(slotInWindow(page, now, now), false)
})

test('a time inside the notice period is refused, the first minute past it is not', () => {
  assert.equal(slotInWindow(page, at(239), now), false)
  assert.equal(slotInWindow(page, at(240), now), true)
})

test('the horizon is exclusive, the same as the offered grid', () => {
  const horizon = 30 * 24 * 60
  assert.equal(slotInWindow(page, at(horizon - 1), now), true)
  assert.equal(slotInWindow(page, at(horizon), now), false)
  assert.equal(slotInWindow(page, at(horizon + 24 * 60), now), false)
})

test('no notice period allows a time one minute away', () => {
  assert.equal(slotInWindow({ minNoticeMinutes: 0, maxHorizonDays: 1 }, at(1), now), true)
})

test('windows that touch are fine, windows that share a minute are not', () => {
  assert.equal(windowProblem('Monday', [['09:00', '12:00'], ['12:00', '17:00']]), null)
  assert.equal(
    windowProblem('Monday', [['09:00', '12:00'], ['11:59', '17:00']]),
    'Monday has 09:00-12:00 and 11:59-17:00 overlapping. Merge them into one window.',
  )
})

test('overlaps are found whatever order the windows arrive in, and a window inside another is one', () => {
  assert.equal(
    windowProblem('Monday', [['13:00', '17:00'], ['09:00', '14:00']]),
    'Monday has 09:00-14:00 and 13:00-17:00 overlapping. Merge them into one window.',
  )
  assert.equal(
    windowProblem('Monday', [['09:00', '17:00'], ['12:00', '13:00'], ['10:00', '11:00']]),
    'Monday has 09:00-17:00 and 10:00-11:00 overlapping. Merge them into one window.',
  )
})

test('a window that does not end after it starts is refused, a window ending at midnight is not', () => {
  assert.equal(windowProblem('Monday', [['09:00', '09:00']]), 'Monday has a window from 09:00 to 09:00. It has to end after it starts.')
  assert.equal(windowProblem('Monday', [['17:00', '09:00']]), 'Monday has a window from 17:00 to 09:00. It has to end after it starts.')
  assert.equal(windowProblem('Monday', [['09:00', '24:00']]), null)
})

test('a cleared time is named as missing, and no windows is fine', () => {
  assert.equal(windowProblem('Monday', [['', '17:00']]), 'Monday has a window with no time set.')
  assert.equal(windowProblem('Monday', []), null)
})

test('the schedule names the weekday of the first bad day', () => {
  assert.equal(
    scheduleProblem({ '1': [['09:00', '17:00']], '3': [['09:00', '13:00'], ['12:00', '17:00']] }),
    'Wednesday has 09:00-13:00 and 12:00-17:00 overlapping. Merge them into one window.',
  )
  assert.equal(scheduleProblem({ '1': [['09:00', '12:00'], ['12:00', '17:00']] }), null)
  assert.equal(scheduleProblem({}), null)
})

const utcDay = (at: Date) => at.toISOString().slice(0, 10)

test('the calendar day of an instant is read on the zone clock, at the hour the zones flip', () => {
  // Los Angeles is UTC-7 in summer and UTC-8 in winter, so its day turns over at 07:00Z or 08:00Z.
  assert.equal(dayKey(new Date('2026-07-16T06:59:59Z'), 'America/Los_Angeles'), '2026-07-15')
  assert.equal(dayKey(new Date('2026-07-16T07:00:00Z'), 'America/Los_Angeles'), '2026-07-16')
  assert.equal(dayKey(new Date('2026-01-16T07:59:59Z'), 'America/Los_Angeles'), '2026-01-15')
  assert.equal(dayKey(new Date('2026-01-16T08:00:00Z'), 'America/Los_Angeles'), '2026-01-16')
  // Between 17:00 and midnight Pacific in summer the UTC day is already tomorrow.
  assert.equal(utcDay(new Date('2026-07-16T02:00:00Z')), '2026-07-16')
  assert.equal(dayKey(new Date('2026-07-16T02:00:00Z'), 'America/Los_Angeles'), '2026-07-15')
})

test('a half-hour zone and a zone ahead of UTC read their own day', () => {
  // Kolkata is UTC+5:30: its day starts at 18:30Z the day before.
  assert.equal(dayKey(new Date('2026-10-07T18:29:59Z'), 'Asia/Kolkata'), '2026-10-07')
  assert.equal(dayKey(new Date('2026-10-07T18:30:00Z'), 'Asia/Kolkata'), '2026-10-08')
  // Auckland is UTC+13 in January, so its day has already turned at 11:00Z.
  assert.equal(dayKey(new Date('2026-01-15T10:59:59Z'), 'Pacific/Auckland'), '2026-01-15')
  assert.equal(dayKey(new Date('2026-01-15T11:00:00Z'), 'Pacific/Auckland'), '2026-01-16')
  // Kiritimati is UTC+14, the furthest ahead of UTC there is.
  assert.equal(dayKey(new Date('2026-10-07T09:59:59Z'), 'Pacific/Kiritimati'), '2026-10-07')
  assert.equal(dayKey(new Date('2026-10-07T10:00:00Z'), 'Pacific/Kiritimati'), '2026-10-08')
  assert.equal(dayKey(new Date('2026-10-07T23:59:59Z'), 'UTC'), '2026-10-07')
})

test('the day rolls over the year and the DST changes in both directions', () => {
  // Spring forward, 2026-03-08 02:00 PST to 03:00 PDT at 10:00Z.
  assert.equal(dayKey(new Date('2026-03-08T09:59:59Z'), 'America/Los_Angeles'), '2026-03-08')
  assert.equal(dayKey(new Date('2026-03-08T10:00:00Z'), 'America/Los_Angeles'), '2026-03-08')
  // Fall back, 2026-11-01 02:00 PDT to 01:00 PST at 09:00Z.
  assert.equal(dayKey(new Date('2026-11-01T08:30:00Z'), 'America/Los_Angeles'), '2026-11-01')
  assert.equal(dayKey(new Date('2026-11-01T09:30:00Z'), 'America/Los_Angeles'), '2026-11-01')
  // New Year, in both directions.
  assert.equal(dayKey(new Date('2026-12-31T09:59:59Z'), 'Pacific/Kiritimati'), '2026-12-31')
  assert.equal(dayKey(new Date('2027-01-01T05:00:00Z'), 'America/Los_Angeles'), '2026-12-31')
})

test('adding days moves the calendar, across months, years, leap days and DST', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2027-01-01', -1), '2026-12-31')
  assert.equal(addDays('2026-01-31', 1), '2026-02-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(addDays('2028-02-28', 1), '2028-02-29')
  assert.equal(addDays('2026-03-07', 1), '2026-03-08')
  assert.equal(addDays('2026-10-07', 0), '2026-10-07')
})

test('a day counted in milliseconds from now lands on the wrong day across DST, adding calendar days does not', () => {
  // 2026-03-07 23:30 in Los Angeles is PST. Twenty-four elapsed hours later the clock
  // reads 00:30 on the 9th, because the 8th lost an hour. "Tomorrow" is the 8th.
  const now = new Date('2026-03-08T07:30:00Z')
  const zone = 'America/Los_Angeles'
  assert.equal(dayKey(now, zone), '2026-03-07')
  assert.equal(dayKey(new Date(now.getTime() + 86_400_000), zone), '2026-03-09')
  assert.equal(addDays(dayKey(now, zone), 1), '2026-03-08')
})
