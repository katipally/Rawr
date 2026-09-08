import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BOOKING_COPY,
  bookingNextAvailable,
  countdown,
  formatterSource,
  formRedirecting,
  formStep,
  FORM_COPY,
} from './edge-copy.ts'

/** The words a stranger reads when something is in flight or has gone wrong.
 *  Tested because they are shared by four surfaces, and because two of them are
 *  functions with arithmetic in them. */

test('a countdown reads as minutes and padded seconds', () => {
  assert.equal(countdown(5 * 60_000), '5:00')
  assert.equal(countdown(65_000), '1:05')
  assert.equal(countdown(9_000), '0:09')
})

test('a countdown never goes negative, so an expired hold does not read as minus one', () => {
  assert.equal(countdown(-1), '0:00')
  assert.equal(countdown(-90_000), '0:00')
})

test('and never renders sixty seconds', () => {
  assert.equal(countdown(59_600), '1:00')
})

test('the redirect notice is singular at one second', () => {
  assert.equal(formRedirecting(1), 'Taking you there now…')
  assert.equal(formRedirecting(0), 'Taking you there now…')
  assert.equal(formRedirecting(3), 'Taking you there in 3 seconds…')
})

test('the step label counts from one, because nobody reads "step 0"', () => {
  assert.equal(formStep(1, 3), 'Step 1 of 3')
})

test('every failure says the answers survived, so nobody retypes them', () => {
  assert.equal(FORM_COPY.failed.includes('Nothing was lost'), true)
  assert.equal(BOOKING_COPY.failed.includes('Nothing was lost'), true)
  assert.equal(FORM_COPY.offline.includes('still here'), true)
  assert.equal(BOOKING_COPY.offline.includes('still here'), true)
})

test('no message shows a status code or blames the visitor', () => {
  const all: string[] = [...Object.values(FORM_COPY), ...Object.values(BOOKING_COPY)]
  assert.equal(
    all.some((line) => /\b[45]\d\d\b/.test(line)),
    false,
  )
  assert.equal(
    all.some((line) => /error occurred|invalid input|bad request/i.test(line)),
    false,
  )
})

test('the next-available notice names when', () => {
  assert.equal(bookingNextAvailable('Monday 7 September').includes('Monday 7 September'), true)
})

test('the tables are strings only, so they survive being serialised into a script', () => {
  const values = [...Object.values(FORM_COPY), ...Object.values(BOOKING_COPY)]
  assert.equal(values.every((value) => typeof value === 'string'), true)
  // The round trip the embed actually performs.
  assert.deepEqual(JSON.parse(JSON.stringify(FORM_COPY)), { ...FORM_COPY })
  assert.deepEqual(JSON.parse(JSON.stringify(BOOKING_COPY)), { ...BOOKING_COPY })
})

test('the formatters shipped to the browser are the ones that were tested', () => {
  const source = formatterSource()
  for (const name of ['formRedirecting', 'formStep']) {
    assert.equal(source.includes('function ' + name), true, `${name} is missing from the inlined source`)
  }
  // Nothing from outside itself, or it throws the moment it runs in the embed.
  assert.equal(/\bimport\b|\brequire\(/.test(source), false)
})
