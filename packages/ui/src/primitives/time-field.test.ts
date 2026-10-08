import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clockLabel, committedOnBlur, minutesOf, parseClock, suggestedTimes } from './time-field.ts'

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

test('blur keeps a typed time, clears on blank, and reverts anything that is not a time', () => {
  assert.equal(committedOnBlur('14:30', undefined, false, '09:00'), '14:30')
  assert.equal(committedOnBlur('25:00', undefined, false, '09:00'), '09:00')
  assert.equal(committedOnBlur('2:5', undefined, false, '09:00'), '09:00')
  assert.equal(committedOnBlur('', undefined, false, '09:00'), '')
  assert.equal(committedOnBlur(null, undefined, false, '09:00'), '09:00')
})

test('blur never commits a suggestion the user only passed over', () => {
  assert.equal(committedOnBlur('25:00', '07:30', false, '09:00'), '09:00')
  assert.equal(committedOnBlur('2', '12:00', false, '09:00'), '02:00')
  assert.equal(committedOnBlur(null, '07:30', false, '09:00'), '09:00')
})

test('blur commits the highlighted suggestion only after the arrow keys moved onto it', () => {
  assert.equal(committedOnBlur('25:00', '07:30', true, '09:00'), '07:30')
  assert.equal(committedOnBlur(null, '06:00', true, '09:00'), '06:00')
  assert.equal(committedOnBlur('14:30', undefined, true, '09:00'), '14:30')
})
