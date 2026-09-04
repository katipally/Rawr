import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HONEYPOT_FIELD } from './form-schema.ts'
import {
  answersFingerprint,
  applyChallenge,
  CONFIRMED_SPAM_AT,
  hashIp,
  QUARANTINE_AT,
  scoreSubmission,
  type SpamInput,
} from './spam.ts'

/** The scorer decides whether a real prospect reaches Slack or sits in a queue
 *  nobody opens. The weights are the F3 spec, so these assert the bands and the
 *  combinations rather than restating the table. */

const submission = (over: Partial<SpamInput> = {}): SpamInput => ({
  raw: {},
  answers: { first_name: 'Trevor', message: 'We would like a demo.' },
  email: 'trevor@datasaur.ai',
  fillSeconds: 30,
  degradedSignals: false,
  duplicateWithin60s: false,
  ...over,
})

test('an ordinary submission scores nothing and is clean', () => {
  const verdict = scoreSubmission(submission())
  assert.equal(verdict.score, 0)
  assert.equal(verdict.state, 'clean')
  assert.equal(verdict.needsChallenge, false)
  assert.deepEqual(verdict.reasons, [])
})

test('a filled honeypot alone is not yet confirmed spam, but is held', () => {
  const verdict = scoreSubmission(submission({ raw: { [HONEYPOT_FIELD]: 'http://spam.example' } }))
  assert.equal(verdict.score, 40)
  assert.equal(verdict.state, 'quarantined')
  assert.equal(verdict.needsChallenge, true)
})

test('honeypot plus a two-second fill is over the confirmed line', () => {
  const verdict = scoreSubmission(
    submission({ raw: { [HONEYPOT_FIELD]: 'x' }, fillSeconds: 0.3 }),
  )
  assert.equal(verdict.score, 70)
  assert.equal(verdict.state, 'confirmed_spam')
  // Past the confirmed line a challenge would prove nothing.
  assert.equal(verdict.needsChallenge, false)
})

test('a no-JS submission is penalised, but nowhere near enough to be held', () => {
  // The rule that matters: scoring the absence of signals as heavily as a filled
  // honeypot would quarantine every person browsing with JavaScript off.
  const verdict = scoreSubmission(submission({ degradedSignals: true, fillSeconds: null }))
  assert.equal(verdict.score, 15)
  assert.equal(verdict.state, 'clean')
})

test('a stale page and a fast fill are the two ends of the timing check', () => {
  assert.equal(scoreSubmission(submission({ fillSeconds: 1.9 })).score, 30)
  assert.equal(scoreSubmission(submission({ fillSeconds: 2 })).score, 0)
  assert.equal(scoreSubmission(submission({ fillSeconds: 12 * 60 * 60 })).score, 0)
  assert.equal(scoreSubmission(submission({ fillSeconds: 12 * 60 * 60 + 1 })).score, 10)
})

test('a throwaway address scores but a personal one does not', () => {
  assert.equal(scoreSubmission(submission({ email: 'x@mailinator.com' })).score, 30)
  // A gmail.com address is a real person using a personal address.
  assert.equal(scoreSubmission(submission({ email: 'x@gmail.com' })).score, 0)
})

test('links only count past two', () => {
  const links = (n: number) =>
    scoreSubmission(
      submission({ answers: { m: Array.from({ length: n }, (_, i) => `http://a${i}.example`).join(' ') } }),
    ).score
  assert.equal(links(2), 0)
  assert.equal(links(3), 20)
})

test('every reason carries a sentence a reviewer can read', () => {
  const verdict = scoreSubmission(
    submission({ raw: { [HONEYPOT_FIELD]: 'x' }, fillSeconds: 0.3, duplicateWithin60s: true }),
  )
  assert.ok(verdict.reasons.length >= 3)
  for (const reason of verdict.reasons) {
    assert.ok(reason.detail.length > 0, reason.rule)
    assert.ok(reason.points > 0, reason.rule)
  }
})

test('both thresholds are inclusive, so a score exactly on the line crosses it', () => {
  // tooFast is worth exactly the quarantine threshold, and adding the honeypot
  // lands exactly on the confirmed one. A ">" instead of a ">=" in stateFor
  // would let both of these through.
  const onQuarantine = scoreSubmission(submission({ fillSeconds: 0.3 }))
  assert.equal(onQuarantine.score, QUARANTINE_AT)
  assert.equal(onQuarantine.state, 'quarantined')

  const onConfirmed = scoreSubmission(
    submission({ fillSeconds: 0.3, raw: { [HONEYPOT_FIELD]: 'x' } }),
  )
  assert.equal(onConfirmed.score, CONFIRMED_SPAM_AT)
  assert.equal(onConfirmed.state, 'confirmed_spam')
})

test('a passed challenge clears a held submission', () => {
  const held = scoreSubmission(submission({ raw: { [HONEYPOT_FIELD]: 'x' } }))
  assert.equal(applyChallenge(held, 'passed').state, 'clean')
})

test('an unreachable challenge fails closed to the queue, never to accepted', () => {
  const held = scoreSubmission(submission({ raw: { [HONEYPOT_FIELD]: 'x' } }))
  for (const outcome of ['failed', 'unavailable'] as const) {
    const settled = applyChallenge(held, outcome)
    assert.equal(settled.state, 'quarantined', outcome)
    assert.equal(settled.needsChallenge, false, outcome)
    assert.ok(settled.reasons.length > held.reasons.length, 'the outcome is recorded')
  }
})

test('a challenge never touches a submission that did not need one', () => {
  const clean = scoreSubmission(submission())
  assert.deepEqual(applyChallenge(clean, 'failed'), clean)
})

test('the fingerprint ignores key order and whitespace, not content', () => {
  const a = answersFingerprint({ email: 'a@b.com', name: ' Trevor ' })
  const b = answersFingerprint({ name: 'trevor', email: 'A@B.COM' })
  assert.equal(a, b)
  assert.notEqual(a, answersFingerprint({ name: 'trevor', email: 'other@b.com' }))
})

test('an IP hash rotates daily and is never the address', () => {
  const day = new Date('2026-09-03T12:00:00Z')
  const next = new Date('2026-09-04T12:00:00Z')
  const today = hashIp('203.0.113.9', 'salt', day)
  assert.equal(today, hashIp('203.0.113.9', 'salt', day), 'stable inside a day')
  assert.notEqual(today, hashIp('203.0.113.9', 'salt', next), 'rotates the next day')
  assert.notEqual(today, hashIp('203.0.113.9', 'other-salt', day), 'the salt rotates it too')
  assert.ok(!String(today).includes('203'), 'the address does not survive')
  assert.equal(hashIp(null, 'salt', day), null)
})
