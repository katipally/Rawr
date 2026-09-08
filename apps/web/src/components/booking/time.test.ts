import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addDays,
  dayKeyIn,
  monthCells,
  monthKeyOf,
  offsetLabel,
  shiftMonth,
  weekInfo,
} from './time.ts'

/** The arithmetic the calendar is drawn from. Every case here is one that has been
 *  got wrong before: a slot landing on a different date depending on where you are,
 *  a month grid off by a column, and a year boundary. */

test('a slot belongs to the date it happens on where the visitor is', () => {
  // 23:30 in Los Angeles on the 8th is 14:30 on the 9th in Jakarta, and the person
  // in Jakarta is right about which day they are booking.
  const at = new Date('2026-09-09T06:30:00Z')
  assert.equal(dayKeyIn(at, 'America/Los_Angeles'), '2026-09-08')
  assert.equal(dayKeyIn(at, 'Asia/Jakarta'), '2026-09-09')
  assert.equal(dayKeyIn(at, 'UTC'), '2026-09-09')
})

test('months step without falling into the year boundary', () => {
  assert.equal(shiftMonth('2026-12', 1), '2027-01')
  assert.equal(shiftMonth('2026-01', -1), '2025-12')
  assert.equal(shiftMonth('2026-09', 3), '2026-12')
})

test('a day steps across a month and a year', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01')
  assert.equal(addDays('2027-01-01', -1), '2026-12-31')
  assert.equal(addDays('2028-02-28', 1), '2028-02-29')
})

test('the month key of a date is its month', () => {
  assert.equal(monthKeyOf('2026-09-08'), '2026-09')
})

test('the grid is padded to the weekday the locale starts its week on', () => {
  // 1 September 2026 is a Tuesday. Sunday-first pads two, Monday-first pads one.
  const sundayFirst = monthCells('2026-09', 0)
  const mondayFirst = monthCells('2026-09', 1)
  assert.deepEqual(sundayFirst.slice(0, 3), [null, null, '2026-09-01'])
  assert.deepEqual(mondayFirst.slice(0, 2), [null, '2026-09-01'])
  assert.equal(sundayFirst.filter(Boolean).length, 30)
  assert.equal(mondayFirst.at(-1), '2026-09-30')
})

test('a month starting on the first day of the week is not padded', () => {
  // 1 November 2026 is a Sunday.
  assert.equal(monthCells('2026-11', 0)[0], '2026-11-01')
})

test('the week starts where the locale says it does, counted from Sunday', () => {
  assert.equal(weekInfo('en-US').firstDay, 0)
  assert.equal(weekInfo('en-GB').firstDay, 1)
  assert.equal(weekInfo('en-US').weekdays.length, 7)
})

test('an unreadable locale tag falls back rather than throwing', () => {
  assert.equal(weekInfo('not a locale').weekdays.length, 7)
})

test('the offset is the one in force on the day, not a fixed number', () => {
  // London is on summer time in September and back on GMT in January.
  assert.equal(offsetLabel('Europe/London', new Date('2026-09-06T12:00:00Z')), 'GMT+1')
  // Runtimes disagree on whether zero is "GMT" or "GMT+0"; both say the same thing.
  assert.match(offsetLabel('Europe/London', new Date('2027-01-06T12:00:00Z')), /^GMT(\+0)?$/)
})
