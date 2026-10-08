import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cancelledWhy, rescheduleWindow } from './booking-manage.ts'

test('the cancelled sentence ends with a full stop', () => {
  assert.equal(cancelledWhy(null), '.')
  assert.equal(cancelledWhy('   '), '.')
  assert.equal(cancelledWhy('Clash with a board call'), ': Clash with a board call.')
  assert.equal(cancelledWhy('  Clash with a board call  '), ': Clash with a board call.')
})

test('a reason that already ends a sentence is not given a second stop', () => {
  assert.equal(cancelledWhy('Clash with a board call.'), ': Clash with a board call.')
  assert.equal(cancelledWhy('Can we move it?'), ': Can we move it?')
})

test('the reschedule window runs from now to the page horizon in days', () => {
  const now = new Date('2026-10-08T09:00:00Z')
  const window = rescheduleWindow(now, 14)
  assert.equal(window.from.getTime(), now.getTime())
  assert.equal(window.to.getTime() - now.getTime(), 14 * 86_400_000)
  assert.equal(rescheduleWindow(now, 60).to.getTime() - now.getTime(), 60 * 86_400_000)
})
