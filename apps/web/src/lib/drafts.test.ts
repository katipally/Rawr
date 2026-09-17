import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DRAFT_EXPIRY_MS, draftKey, readDraft } from './draft-read.ts'

/** `readDraft` is the pure half of `useDraft` (drafts.ts): given a raw
 *  `localStorage` read and "now", what should happen. The other half -- not
 *  writing until a restore has been attempted, so the empty first render of a
 *  form can never clobber a real draft -- is a React effect-ordering guarantee
 *  that needs a DOM (jsdom, or @testing-library/react) to exercise a real
 *  mount. Neither is a dependency of this repo, so that half is covered here
 *  only indirectly, by pinning the exact expiry boundary the hook's own
 *  removal decision is built on. */

test('a key with a record id nests under it; one without stays account/object wide', () => {
  assert.equal(draftKey('datasaur', 'contact', undefined), 'rawr:draft:datasaur:contact')
  assert.equal(draftKey('datasaur', 'task', 'task-1'), 'rawr:draft:datasaur:task:task-1')
})

test('nothing stored reads as none, not expired', () => {
  assert.deepEqual(readDraft(null, Date.now()), { kind: 'none' })
})

test('unparsable or shape-less content reads as none rather than throwing', () => {
  assert.deepEqual(readDraft('not json', Date.now()), { kind: 'none' })
  assert.deepEqual(readDraft('{}', Date.now()), { kind: 'none' })
  assert.deepEqual(readDraft(JSON.stringify({ value: { a: 1 } }), Date.now()), { kind: 'none' })
})

test('a fresh save restores its value', () => {
  const now = Date.now()
  const raw = JSON.stringify({ savedAt: now, value: { subject: 'hi' } })
  assert.deepEqual(readDraft(raw, now), { kind: 'value', value: { subject: 'hi' } })
})

test('a save right at the edge of the window still restores', () => {
  const now = Date.now()
  const raw = JSON.stringify({ savedAt: now - (DRAFT_EXPIRY_MS - 1), value: { a: 1 } })
  assert.deepEqual(readDraft(raw, now), { kind: 'value', value: { a: 1 } })
})

test('a save past the window is expired, not restored', () => {
  const now = Date.now()
  const raw = JSON.stringify({ savedAt: now - DRAFT_EXPIRY_MS, value: { a: 1 } })
  assert.deepEqual(readDraft(raw, now), { kind: 'expired' })
})

test('an old empty draft is expired the same as an old real one', () => {
  const now = Date.now()
  const raw = JSON.stringify({ savedAt: now - DRAFT_EXPIRY_MS * 2, value: {} })
  assert.deepEqual(readDraft(raw, now), { kind: 'expired' })
})
