import assert from 'node:assert/strict'
import { test } from 'node:test'
import { daysChanged, toWeekly, toWindows, weeklyHours, windowsChanged, type Ranges, type Window } from './windows.ts'

let n = 0
const key = () => String(n++)
const shape = (ranges: Ranges) => toWindows(ranges, key).map(({ days, from, to }) => `${days} ${from}-${to}`)

test('identical weekdays read back as one Mon - Fri row', () => {
  const weekly: Ranges = { '1': [['09:00', '17:00']], '2': [['09:00', '17:00']], '3': [['09:00', '17:00']], '4': [['09:00', '17:00']], '5': [['09:00', '17:00']] }
  assert.deepEqual(shape(weekly), ['weekdays 09:00-17:00'])
})

test('a week of the same hours is Every day, and odd days keep their own rows', () => {
  const all = Object.fromEntries(['1', '2', '3', '4', '5', '6', '7'].map((day) => [day, [['08:00', '12:00']]])) as Ranges
  assert.deepEqual(shape(all), ['every 08:00-12:00'])
  assert.deepEqual(shape({ '1': [['09:00', '12:00'], ['13:00', '17:00']], '6': [['10:00', '14:00']], '7': [['10:00', '14:00']] }), [
    '1 09:00-12:00',
    'weekends 10:00-14:00',
    '1 13:00-17:00',
  ])
})

test('rows write back the map they were read from', () => {
  const weekly: Ranges = { '1': [['09:00', '12:00'], ['13:00', '17:00']], '2': [['09:00', '12:00']], '6': [['10:00', '11:00']] }
  assert.deepEqual(toWeekly(toWindows(weekly, key)), weekly)
  assert.equal(daysChanged(toWeekly(toWindows(weekly, key)), weekly), 0)
})

test('two rows giving a day the same range store it once, in start order', () => {
  const weekly = toWeekly([
    { key: 'a', days: 'weekdays', from: '13:00', to: '17:00' },
    { key: 'b', days: '1', from: '13:00', to: '17:00' },
    { key: 'c', days: '1', from: '08:00', to: '10:00' },
  ])
  assert.deepEqual(weekly['1'], [['08:00', '10:00'], ['13:00', '17:00']])
  assert.equal(weekly['6'], undefined)
  assert.equal(daysChanged(weekly, {}), 5)
})

test('no hours at all is no rows', () => {
  assert.deepEqual(toWindows({}, key), [])
  assert.deepEqual(toWeekly([]), {})
})

test('one edited window counts once, however many days it covers', () => {
  const saved: Window[] = [{ key: 'a', days: 'weekdays', from: '09:00', to: '17:00' }]
  assert.equal(windowsChanged([{ ...saved[0]!, to: '18:00' }], saved), 1)
  assert.equal(windowsChanged(saved, saved), 0)
})

test('a window added or removed counts once, and removing the first does not count the rest', () => {
  const saved: Window[] = [
    { key: 'a', days: '1', from: '09:00', to: '10:00' },
    { key: 'b', days: '2', from: '09:00', to: '10:00' },
    { key: 'c', days: '3', from: '09:00', to: '10:00' },
  ]
  assert.equal(windowsChanged(saved.slice(1), saved), 1)
  assert.equal(windowsChanged([...saved, { key: 'd', days: '4', from: '09:00', to: '10:00' }], saved), 1)
  assert.equal(windowsChanged([], saved), 3)
})

test('hours that overlap are counted once', () => {
  assert.equal(weeklyHours({ '1': [['09:00', '13:00'], ['09:00', '17:00']] }), 8)
  assert.equal(weeklyHours({ '1': [['09:00', '17:00'], ['10:00', '11:00']] }), 8)
  assert.equal(weeklyHours({ '1': [['13:00', '17:00'], ['09:00', '14:00']] }), 8)
})

test('hours that touch are one block, and disjoint hours add up', () => {
  assert.equal(weeklyHours({ '1': [['09:00', '12:00'], ['12:00', '17:00']] }), 8)
  assert.equal(weeklyHours({ '1': [['09:00', '12:00'], ['13:00', '17:00']] }), 7)
})

test('a week sums each day on its own, so the same hours on two days are both counted', () => {
  assert.equal(weeklyHours({ '1': [['09:00', '17:00']], '2': [['09:00', '17:00']], '6': [['10:00', '14:00']] }), 20)
  assert.equal(weeklyHours({ '1': [['09:00', '13:00'], ['09:00', '17:00']], '6': [['10:00', '14:00']] }), 12)
  assert.equal(weeklyHours({}), 0)
})
