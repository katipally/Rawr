import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clockLabel,
  closedField,
  minutesOf,
  narrow,
  parseClock,
  stepTimeField,
  suggestedTimes,
  type TimeFieldEvent,
  type TimeRow,
} from './time-field.ts'

test('a quarter-hour list covers the whole day in order', () => {
  const times = suggestedTimes(15)
  assert.equal(times.length, 96)
  assert.equal(times[0], '00:00')
  assert.equal(times[1], '00:15')
  assert.equal(times.at(-1), '23:45')
  assert.deepEqual(times, [...times].sort())
})

test('a step that does not divide the day still stays inside it', () => {
  assert.equal(suggestedTimes(60).length, 24)
  assert.equal(suggestedTimes(1440).length, 1)
})

test('a stored time is read as minutes only when it is a clock time', () => {
  assert.equal(minutesOf('09:30'), 570)
  assert.equal(minutesOf('23:59'), 1439)
  assert.equal(minutesOf('24:00'), null)
  assert.equal(minutesOf('9:30'), null)
  assert.equal(minutesOf(''), null)
})

test('a clock time reads in the locale, and anything else is shown as stored', () => {
  const us = clockLabel('09:30', 'en-US').replaceAll(/\s/g, '')
  assert.equal(us, '9:30AM')
  assert.equal(clockLabel('14:05', 'de-DE'), '14:05')
  assert.equal(clockLabel('24:00', 'en-US'), '24:00')
  assert.equal(clockLabel('', 'en-US'), '')
})

test('typed times read with or without a colon, and with or without a half of the day', () => {
  assert.equal(parseClock('9:30'), '09:30')
  assert.equal(parseClock('930'), '09:30')
  assert.equal(parseClock('0930'), '09:30')
  assert.equal(parseClock('9'), '09:00')
  assert.equal(parseClock('14:30'), '14:30')
  assert.equal(parseClock('9:30 pm'), '21:30')
  assert.equal(parseClock('9.30p'), '21:30')
  assert.equal(parseClock('9a'), '09:00')
  assert.equal(parseClock(' 1 PM '), '13:00')
})

test('the twelve o’clock hours land on midnight and noon', () => {
  assert.equal(parseClock('12am'), '00:00')
  assert.equal(parseClock('12:30am'), '00:30')
  assert.equal(parseClock('12pm'), '12:00')
  assert.equal(parseClock('12:15 pm'), '12:15')
})

test('text that is not a time is refused, not guessed at', () => {
  assert.equal(parseClock(''), null)
  assert.equal(parseClock('9:3'), null)
  assert.equal(parseClock('24:00'), null)
  assert.equal(parseClock('13pm'), null)
  assert.equal(parseClock('0am'), null)
  assert.equal(parseClock('9:60'), null)
  assert.equal(parseClock('noon'), null)
  assert.equal(parseClock('9'.repeat(10_000)), null)
})

test('out-of-range and partial readings are refused, never rounded into a time', () => {
  assert.equal(parseClock('25:00'), null)
  assert.equal(parseClock('24:01'), null)
  assert.equal(parseClock('12:60'), null)
  assert.equal(parseClock('99'), null)
  assert.equal(parseClock('0:0:0'), null)
  assert.equal(parseClock('2:5'), null)
  assert.equal(parseClock('25:0'), null)
  assert.equal(parseClock('9:30 pm pm'), null)
})

const rows: TimeRow[] = suggestedTimes(15).map((value) => ({ value, label: clockLabel(value, 'en-US') }))
const at = (value: string) => rows.findIndex((row) => row.value === value)
const text = (typed: string): TimeFieldEvent => ({ type: 'text', text: typed })
const arrow = (step: 1 | -1): TimeFieldEvent => ({ type: 'arrow', step })
const hover = (value: string): TimeFieldEvent => ({ type: 'hoverEnter', index: at(value) })
const settle: TimeFieldEvent = { type: 'settle' }

/** Runs events against a stored value the way the field does, collecting each onChange. */
const play = (value: string, events: TimeFieldEvent[]) => {
  const emits: string[] = []
  const state = events.reduce((current, event) => {
    const step = stepTimeField(current, event, value, rows)
    if (step.emit !== null) emits.push(step.emit)
    return step.state
  }, closedField)
  return { state, emits }
}

test('arrow-opened list with the mouse resting over another row: tab keeps the stored time', () => {
  const { state, emits } = play('09:00', [
    arrow(1),
    hover('09:15'),
    { type: 'hoverLeave' },
    hover('09:15'),
    settle,
  ])
  assert.deepEqual(emits, [])
  assert.equal(state.typed, null)
})

test('enter with a resting pointer keeps the stored time, not the hovered row', () => {
  assert.deepEqual(play('09:15', [arrow(1), hover('09:30'), settle]).emits, [])
})

test('hover while typing never picks a row: blur keeps the typed time', () => {
  assert.deepEqual(play('10:00', [text('9'), hover('09:00'), hover('09:30'), settle]).emits, ['09:00'])
})

test('typing an invalid time reverts on blur, and no keystroke commits anything', () => {
  const { state, emits } = play('10:00', [
    text('2'),
    text('25'),
    text('25:'),
    text('25:0'),
    text('25:00'),
    hover('07:45'),
    settle,
  ])
  assert.deepEqual(emits, [])
  assert.equal(state.typed, null)
})

test('arrow keys walk the list from the stored time, and tab commits the row they stopped on', () => {
  assert.deepEqual(play('09:30', [{ type: 'open' }, arrow(1), arrow(1), settle]).emits, ['10:00'])
})

test('tabbing over the stored time as typed changes nothing', () => {
  assert.deepEqual(play('09:30', [text('9:30'), settle]).emits, [])
})

test('escape closes the list and restores the stored time, so a later blur has nothing to commit', () => {
  const typedThenEscape = play('09:00', [text('14:30'), { type: 'escape' }, settle])
  assert.deepEqual(typedThenEscape.emits, [])
  assert.equal(typedThenEscape.state.typed, null)
  assert.equal(typedThenEscape.state.open, false)
  assert.deepEqual(play('09:00', [arrow(1), arrow(1), { type: 'escape' }, settle]).emits, [])
})

test('clicking a row picks it, and clicking the stored row changes nothing', () => {
  const picked = play('09:00', [{ type: 'open' }, { type: 'pick', value: '11:30' }])
  assert.deepEqual(picked.emits, ['11:30'])
  assert.equal(picked.state.open, false)
  assert.deepEqual(play('09:00', [{ type: 'open' }, { type: 'pick', value: '09:00' }]).emits, [])
})

test('blank text clears the time, and a blank field with a stored time stays blank', () => {
  assert.deepEqual(play('09:00', [text(''), settle]).emits, [''])
  assert.deepEqual(play('', [text(''), settle]).emits, [])
})

test('an outside click keeps the typed text for the blur that follows it', () => {
  const { state, emits } = play('09:00', [text('14:30'), { type: 'dismiss' }, settle])
  assert.equal(state.open, false)
  assert.deepEqual(emits, ['14:30'])
})

test('every typed format commits the same stored time', () => {
  const cases: [string, string][] = [
    ['9:30', '09:30'],
    ['930', '09:30'],
    ['9', '09:00'],
    ['9:30 pm', '21:30'],
    ['9.30p', '21:30'],
    ['14:30', '14:30'],
  ]
  for (const [typed, stored] of cases) assert.deepEqual(play('08:00', [text(typed), settle]).emits, [stored], typed)
})

test('the arrow keys highlight among what the typed text leaves, and tab takes that row', () => {
  const narrowed = narrow(rows, '9')
  assert.deepEqual(play('08:00', [text('9'), arrow(1), settle]).emits, [narrowed[1]?.value])
})

test('the list wraps at both ends', () => {
  assert.deepEqual(play('23:45', [arrow(1), arrow(1), settle]).emits, ['00:00'])
  assert.deepEqual(play('00:00', [arrow(-1), arrow(-1), settle]).emits, ['23:45'])
})

test('hover moves only its own light, never the keyboard highlight or touched', () => {
  const { state } = play('09:00', [arrow(1), hover('12:00')])
  assert.equal(state.highlight, at('09:00'))
  assert.equal(state.touched, true)
  assert.equal(state.hover, at('12:00'))
})
