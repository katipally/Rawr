import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capReached, inWindow, mergeFields, nextSendAt, renderMergeFields, type SendWindow } from './sequence-rules.ts'

/** The arithmetic that decides when somebody's prospect gets an email. Getting it
 *  wrong sends at three in the morning, or on a Sunday, or twice. */

const london: SendWindow = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timezone: 'Europe/London' }
const at = (iso: string) => new Date(iso)

test('inside the window on a weekday morning', () => {
  // 10:30 London on a Wednesday in winter, which is 10:30 UTC.
  assert.equal(inWindow(at('2026-01-07T10:30:00Z'), london), true)
})

test('outside it before it opens and after it closes', () => {
  assert.equal(inWindow(at('2026-01-07T08:30:00Z'), london), false)
  assert.equal(inWindow(at('2026-01-07T17:30:00Z'), london), false)
})

test('a Saturday is not a sending day', () => {
  assert.equal(inWindow(at('2026-01-10T10:30:00Z'), london), false)
})

test('the window is wall clock, so summer time moves it against UTC', () => {
  // 09:30 UTC in July is 10:30 in London: inside. 08:30 UTC is 09:30 London,
  // also inside. 07:30 UTC is 08:30 London, which is not.
  assert.equal(inWindow(at('2026-07-08T08:30:00Z'), london), true)
  assert.equal(inWindow(at('2026-07-08T07:30:00Z'), london), false)
})

test('a step due at night waits for the morning', () => {
  const when = nextSendAt({ after: at('2026-01-07T22:00:00Z'), delayDays: 0, delayHours: 0, window: london })
  assert.equal(inWindow(when, london), true)
  assert.equal(when.toISOString().startsWith('2026-01-08T09:0'), true)
})

test('a step due on Saturday waits for Monday', () => {
  const when = nextSendAt({ after: at('2026-01-10T10:00:00Z'), delayDays: 0, delayHours: 0, window: london })
  assert.equal(when.getUTCDay(), 1)
  assert.equal(inWindow(when, london), true)
})

test('a step already inside the window goes now, not at the next opening', () => {
  const now = at('2026-01-07T10:00:00Z')
  assert.equal(nextSendAt({ after: now, delayDays: 0, delayHours: 0, window: london }).getTime(), now.getTime())
})

test('the delay is applied before the window, not after', () => {
  const when = nextSendAt({ after: at('2026-01-07T10:00:00Z'), delayDays: 3, delayHours: 0, window: london })
  // Three days on from Wednesday is Saturday, so it lands on the Monday.
  assert.equal(when.getUTCDay(), 1)
})

test('the minimum gap holds the next send back', () => {
  const when = nextSendAt({
    after: at('2026-01-07T10:00:00Z'),
    delayDays: 0,
    delayHours: 0,
    window: london,
    lastSentAt: at('2026-01-07T10:00:00Z'),
    minGapSeconds: 300,
  })
  assert.equal(when.getTime() >= at('2026-01-07T10:05:00Z').getTime(), true)
})

test('a window with no days at all returns the instant rather than looping', () => {
  const never: SendWindow = { ...london, days: [] }
  const now = at('2026-01-07T10:00:00Z')
  assert.equal(nextSendAt({ after: now, delayDays: 0, delayHours: 0, window: never }).getTime(), now.getTime())
})

test('an always-on window sends at any hour', () => {
  const always: SendWindow = { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59', timezone: 'UTC' }
  assert.equal(inWindow(at('2026-01-11T03:00:00Z'), always), true)
})

test('the cap is reached at the cap, not after it', () => {
  assert.equal(capReached(99, 100), false)
  assert.equal(capReached(100, 100), true)
  assert.equal(capReached(101, 100), true)
})

test('a merge field is replaced by its value', () => {
  assert.equal(renderMergeFields('Hi {{first_name}},', { first_name: 'Trevor' }).text, 'Hi Trevor,')
})

test('a blank value falls back rather than leaving a gap', () => {
  const rendered = renderMergeFields('Hi {{first_name|there}},', { first_name: '' })
  assert.equal(rendered.text, 'Hi there,')
  assert.deepEqual(rendered.missing, [])
})

test('a missing field with no fallback is reported, so the send can be refused', () => {
  const rendered = renderMergeFields('Hi {{first_name}}, about {{company}}', { first_name: 'Trevor' })
  assert.deepEqual(rendered.missing, ['company'])
})

test('whitespace inside the braces is tolerated, because people type it', () => {
  assert.equal(renderMergeFields('Hi {{ first_name }}', { first_name: 'Ada' }).text, 'Hi Ada')
})

test('the fields a template uses are listed once each', () => {
  assert.deepEqual(mergeFields('{{first_name}} {{company}} {{first_name|there}}'), ['first_name', 'company'])
})

test('text with no fields is returned unchanged', () => {
  const rendered = renderMergeFields('No fields here.', {})
  assert.equal(rendered.text, 'No fields here.')
  assert.deepEqual(rendered.missing, [])
})

/** Changing a sequence's sending window moves everybody already waiting, and
 *  `resnapWaiting` works the new time out by calling this again from the moment
 *  the step actually became due: the previous send, or the enrolment for the first
 *  step, plus that step's own wait.
 *
 *  These pin the two cases that pull against each other. Reading the stored
 *  next_run_at as the question instead satisfies the first and breaks the second,
 *  which is a two-day gap between steps thrown away by a change to Saturdays. */

const always: SendWindow = { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59', timezone: 'UTC' }
const utcOffice: SendWindow = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timezone: 'UTC' }

test('widening the window releases somebody the old one had held back', () => {
  // Enrolled 01:31 on a Thursday, first step, no wait. The office window pushed
  // them to 09:00; the round-the-clock one has no reason to.
  const due = at('2026-09-10T01:31:00Z')
  assert.equal(
    nextSendAt({ after: due, delayDays: 0, delayHours: 0, window: utcOffice }).toISOString(),
    '2026-09-10T09:00:00.000Z',
  )
  assert.equal(
    nextSendAt({ after: due, delayDays: 0, delayHours: 0, window: always }).toISOString(),
    due.toISOString(),
  )
})

test('narrowing it keeps the wait between steps rather than pulling the send forward', () => {
  // Step one sent 01:32 on Thursday; step two waits two days, so it is due
  // Saturday 01:32. A weekdays-only window moves it to Monday, never to today.
  const sentAt = at('2026-09-10T01:32:00Z')
  assert.equal(
    nextSendAt({ after: sentAt, delayDays: 2, delayHours: 0, window: always }).toISOString(),
    '2026-09-12T01:32:00.000Z',
  )
  assert.equal(
    nextSendAt({ after: sentAt, delayDays: 2, delayHours: 0, window: utcOffice }).toISOString(),
    '2026-09-14T09:00:00.000Z',
  )
})
