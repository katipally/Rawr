import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SendWindow } from '@rawr/db'
import { readNotice, sendingProblems } from './mailbox-rules.ts'

const window: SendWindow = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timezone: 'UTC' }
const ok = { cap: 50, gap: 60, hours: null }

test('limits inside their ranges need no message', () => {
  assert.deepEqual(sendingProblems(ok), [])
  assert.deepEqual(sendingProblems({ ...ok, cap: 1, gap: 0 }), [])
  assert.deepEqual(sendingProblems({ ...ok, cap: 2000, gap: 86400 }), [])
})

test('a day allowance outside 1 to 2000, or not whole, is named', () => {
  assert.deepEqual(sendingProblems({ ...ok, cap: 0 }), ['Most a day is 1 to 2000.'])
  assert.deepEqual(sendingProblems({ ...ok, cap: 2001 }), ['Most a day is 1 to 2000.'])
  assert.deepEqual(sendingProblems({ ...ok, cap: 1.5 }), ['Most a day is 1 to 2000.'])
  assert.deepEqual(sendingProblems({ ...ok, cap: Number.NaN }), ['Most a day is 1 to 2000.'])
})

test('a gap outside 0 to 86400 is named', () => {
  assert.deepEqual(sendingProblems({ ...ok, gap: -1 }), ['Seconds between sends is 0 to 86400.'])
  assert.deepEqual(sendingProblems({ ...ok, gap: 86401 }), ['Seconds between sends is 0 to 86400.'])
})

test('a window with no day, or an end that is not after the start, is named', () => {
  const message = ['Hours need at least one day and an end after the start.']
  assert.deepEqual(sendingProblems({ ...ok, hours: { ...window, days: [] } }), message)
  assert.deepEqual(sendingProblems({ ...ok, hours: { ...window, end: '09:00' } }), message)
  assert.deepEqual(sendingProblems({ ...ok, hours: { ...window, start: '18:00' } }), message)
  assert.deepEqual(sendingProblems({ ...ok, hours: { ...window, start: '' } }), message)
})

test('a window with a day and an end after the start is valid', () => {
  assert.deepEqual(sendingProblems({ ...ok, hours: window }), [])
})

test('every failing part is named, and only those', () => {
  assert.deepEqual(sendingProblems({ cap: 0, gap: 60, hours: { ...window, days: [] } }), [
    'Most a day is 1 to 2000.',
    'Hours need at least one day and an end after the start.',
  ])
})

test('a read with nothing refused states the counts only', () => {
  assert.equal(
    readNotice({ read: 5, stored: 2, alreadyHad: 3, skipped: 0, reason: null }),
    '5 read: 2 new, 3 already had, 0 refused.',
  )
})

test('a read that refused mail says what is refused and why it is never kept', () => {
  assert.equal(
    readNotice({ read: 5, stored: 2, alreadyHad: 0, skipped: 3, reason: null }),
    '5 read: 2 new, 0 already had, 3 refused. Refused mail is internal, personal or excluded by hand, so it is never stored.',
  )
})

test('a reason from the pass is appended after the counts', () => {
  assert.equal(
    readNotice({ read: 1, stored: 0, alreadyHad: 0, skipped: 0, reason: 'Stopped early: the page limit was reached.' }),
    '1 read: 0 new, 0 already had, 0 refused. Stopped early: the page limit was reached.',
  )
})
