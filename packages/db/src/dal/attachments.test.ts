import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ABANDONED_AFTER_MS, abandonedBefore } from './attachments.ts'

const now = new Date('2026-10-08T12:00:00.000Z')
const abandoned = (expiresAt: Date): boolean => expiresAt <= abandonedBefore(now)
const ago = (ms: number): Date => new Date(now.getTime() - ms)

test('the cutoff is one abandon window before now', () => {
  assert.equal(abandonedBefore(now).getTime(), now.getTime() - ABANDONED_AFTER_MS)
})

test('an upload whose window closed exactly one abandon window ago is abandoned', () => {
  assert.equal(abandoned(ago(ABANDONED_AFTER_MS)), true)
})

test('an upload whose window closed a millisecond less than one abandon window ago is kept', () => {
  assert.equal(abandoned(ago(ABANDONED_AFTER_MS - 1)), false)
})

test('an upload whose window is still open is kept', () => {
  assert.equal(abandoned(new Date(now.getTime() + 1)), false)
})

test('an upload whose window closed long ago is abandoned', () => {
  assert.equal(abandoned(ago(30 * ABANDONED_AFTER_MS)), true)
})
