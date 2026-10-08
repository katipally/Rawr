import assert from 'node:assert/strict'
import { test } from 'node:test'
import { delayFrom, delayText, describeWait, waitFits, waitMinutes } from './wait-input.ts'

const MAX = 366 * 24 * 60

test('a typed amount becomes minutes in its unit', () => {
  assert.equal(waitMinutes('5', 'minutes'), 5)
  assert.equal(waitMinutes('2', 'hours'), 120)
  assert.equal(waitMinutes('2', 'days'), 2880)
})

test('an amount that is not digits has no minutes', () => {
  assert.ok(Number.isNaN(waitMinutes('', 'days')))
  assert.ok(Number.isNaN(waitMinutes('1.5', 'hours')))
  assert.ok(Number.isNaN(waitMinutes('-1', 'minutes')))
  assert.ok(Number.isNaN(waitMinutes('2e3', 'minutes')))
})

test('a wait fits from one minute up to the cap, whole minutes only', () => {
  assert.equal(waitFits(waitMinutes('1', 'minutes'), MAX), true)
  assert.equal(waitFits(waitMinutes('366', 'days'), MAX), true)
  assert.equal(waitFits(waitMinutes('367', 'days'), MAX), false)
  assert.equal(waitFits(waitMinutes('0', 'minutes'), MAX), false)
  assert.equal(waitFits(waitMinutes('', 'minutes'), MAX), false)
  assert.equal(waitFits(waitMinutes('99999999999999999999', 'days'), MAX), false)
})

test('stored minutes read in the largest unit that divides them', () => {
  assert.deepEqual(delayFrom(2880), { amount: '2', unit: 'days' })
  assert.deepEqual(delayFrom(120), { amount: '2', unit: 'hours' })
  assert.deepEqual(delayFrom(90), { amount: '90', unit: 'minutes' })
  assert.equal(describeWait(MAX), '366 days')
  assert.equal(describeWait(1), '1 minute')
})

test('a unit is singular for one and plural otherwise', () => {
  assert.equal(delayText('1', 'hours'), '1 hour')
  assert.equal(delayText('5', 'minutes'), '5 minutes')
})
