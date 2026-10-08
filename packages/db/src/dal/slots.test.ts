import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scheduleProblem, slotInWindow, windowProblem } from './slots.ts'

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
