import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slotInWindow } from './slots.ts'

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
