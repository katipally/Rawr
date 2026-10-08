import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampRange, MAX_DAYS } from '../index.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const days = (from: string, to: string) => ({ from: new Date(`${from}T00:00:00Z`), to: new Date(`${to}T00:00:00Z`) })

test('a range of exactly MAX_DAYS is not clipped', () => {
  const range = clampRange(days('2025-10-07', '2025-10-07'))
  assert.equal(range.clipped, false)
  const exact = clampRange({ from: new Date(0), to: new Date(MAX_DAYS * DAY_MS) })
  assert.equal(exact.clipped, false)
  assert.equal(exact.from.getTime(), 0)
})

test('a range one millisecond longer than MAX_DAYS is clipped to its last MAX_DAYS', () => {
  const end = new Date(MAX_DAYS * DAY_MS + 1)
  const range = clampRange({ from: new Date(0), to: end })
  assert.equal(range.clipped, true)
  assert.equal(range.to.getTime(), end.getTime())
  assert.equal(end.getTime() - range.from.getTime(), MAX_DAYS * DAY_MS)
})

test('a reversed range is clipped on its real span, not on the order it arrived in', () => {
  const range = clampRange({ from: new Date(MAX_DAYS * DAY_MS + 1), to: new Date(0) })
  assert.equal(range.clipped, true)
})
