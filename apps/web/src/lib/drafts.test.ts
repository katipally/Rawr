import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DRAFT_EXPIRY_MS, draftKey, isPristine, purgeDrafts, readDraft } from './draft-read.ts'

/** `readDraft` is the pure half of `useDraft` (drafts.ts): given a raw
 *  `localStorage` read and "now", what should happen. The other half -- not
 *  writing until a restore has been attempted, so the empty first render of a
 *  form can never clobber a real draft -- is a React effect-ordering guarantee
 *  that needs a DOM (jsdom, or @testing-library/react) to exercise a real
 *  mount. Neither is a dependency of this repo, so that half is covered here
 *  only indirectly, by pinning the exact expiry boundary the hook's own
 *  removal decision is built on. */

test('a key with a record id nests under it; one without stays account/object wide', () => {
  assert.equal(draftKey('u1', 'datasaur', 'contact', undefined), 'rawr:drafts:u1:datasaur:contact')
  assert.equal(draftKey('u1', 'datasaur', 'task', 'task-1'), 'rawr:drafts:u1:datasaur:task:task-1')
})

test('two people on one account and form never share a key, and neither matches the old account-only key', () => {
  const keys = ['u1', 'u2', 'u10'].map((user) => draftKey(user, 'datasaur', 'task', undefined))
  assert.equal(new Set(keys).size, 3)
  assert.ok(!keys.includes('rawr:draft:datasaur:task'))
})

const storage = (entries: Record<string, string>) => {
  const data = new Map(Object.entries(entries))
  return {
    store: {
      get length() { return data.size },
      key: (index: number) => [...data.keys()][index] ?? null,
      removeItem: (key: string) => void data.delete(key),
    },
    keys: () => [...data.keys()].sort(),
  }
}

const stored = {
  'rawr:draft:datasaur:task': '{}',
  'rawr:draft:datasaur:email:thread-1': '{}',
  'rawr:drafts:u1:datasaur:task': '{}',
  'rawr:drafts:u1:other:contact': '{}',
  'rawr:drafts:u10:datasaur:task': '{}',
  'rawr:drafts:u2:datasaur:task': '{}',
  'rawr.recent-search': '[]',
  'rawr:signed-out': '1',
}

test('signing out purges every draft, old format and every person, and nothing else', () => {
  const { store, keys } = storage(stored)
  purgeDrafts(store)
  assert.deepEqual(keys(), ['rawr.recent-search', 'rawr:signed-out'])
})

test('a signed-in load keeps only that person drafts, not a person whose id merely starts the same', () => {
  const { store, keys } = storage(stored)
  purgeDrafts(store, 'u1')
  assert.deepEqual(keys(), ['rawr.recent-search', 'rawr:drafts:u1:datasaur:task', 'rawr:drafts:u1:other:contact', 'rawr:signed-out'])
})

test('purging an empty store does nothing', () => {
  const { store, keys } = storage({})
  purgeDrafts(store, 'u1')
  assert.deepEqual(keys(), [])
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

test('a form back at its mount values is pristine, so its draft is dropped rather than saved', () => {
  assert.equal(isPristine({ subject: '', text: '' }, { subject: '', text: '' }), true)
  assert.equal(isPristine({ subject: 'Re: x', text: '' }, { subject: 'Re: x', text: '' }), true)
})

test('an emptied field counts as untouched, whether it was blank or absent at mount', () => {
  assert.equal(isPristine({ email: '', tags: [], pipeline_id: 'p1' }, { pipeline_id: 'p1' }), true)
  assert.equal(isPristine({ email: null, name: undefined }, {}), true)
})

test('real content is not pristine, whether a field is new or differs from mount', () => {
  assert.equal(isPristine({ subject: 'hi', text: '' }, { subject: '', text: '' }), false)
  assert.equal(isPristine({ pipeline_id: 'p2' }, { pipeline_id: 'p1' }), false)
  assert.equal(isPristine({ tags: ['a'] }, { tags: [] }), false)
})
