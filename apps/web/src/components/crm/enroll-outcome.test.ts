import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeEnrollment } from './enroll-outcome.ts'

test('when everyone enrolls there is nothing refused to list', () => {
  const summary = summarizeEnrollment([
    { contactId: 'a', displayName: 'Ada Lovelace', enrolled: true },
    { contactId: 'b', displayName: 'Grace Hopper', enrolled: true },
  ])
  assert.equal(summary.headline, '2 enrolled.')
  assert.deepEqual(summary.refused, [])
})

test('when nobody enrolls the headline says so and the refused rows keep their names', () => {
  const summary = summarizeEnrollment([
    { contactId: 'a', displayName: 'Ada Lovelace', enrolled: false, reason: 'No email address.' },
    { contactId: 'b', displayName: 'Grace Hopper', enrolled: false, reason: 'Already in this sequence.' },
  ])
  assert.equal(summary.headline, 'Nobody was enrolled. 2 were not.')
  assert.equal(summary.enrolled, 0)
  assert.deepEqual(
    summary.refused.map((row) => `${row.displayName}: ${row.reason}`),
    ['Ada Lovelace: No email address.', 'Grace Hopper: Already in this sequence.'],
  )
})

test('a single refusal reads in the singular', () => {
  assert.equal(
    summarizeEnrollment([{ contactId: 'a', displayName: 'Ada Lovelace', enrolled: false, reason: 'No email address.' }]).headline,
    'Nobody was enrolled. 1 was not.',
  )
})

test('a mix says how many went in and names only the ones that did not', () => {
  const summary = summarizeEnrollment([
    { contactId: 'a', displayName: 'Ada Lovelace', enrolled: true },
    { contactId: 'b', displayName: 'Grace Hopper', enrolled: false, reason: 'They have opted out of this kind of mail.' },
    { contactId: 'c', displayName: 'Katherine Johnson', enrolled: true },
  ])
  assert.equal(summary.headline, '2 enrolled, 1 not.')
  assert.equal(summary.enrolled, 2)
  assert.deepEqual(summary.refused.map((row) => row.displayName), ['Grace Hopper'])
})
