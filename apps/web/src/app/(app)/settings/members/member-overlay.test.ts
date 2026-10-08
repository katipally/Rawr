import assert from 'node:assert/strict'
import { test } from 'node:test'
import { overlaid, stage, unstage } from './member-overlay.ts'

type Row = { userId: string; name: string; state: 'active' | 'deactivated' }

const rowsA: Row[] = [
  { userId: 'a', name: 'Ada', state: 'active' },
  { userId: 'b', name: 'Bo', state: 'active' },
]

test('a change shows over the rows it was made against, while the server has not answered', () => {
  const overlays = stage({}, rowsA, 'a', { state: 'deactivated' })
  assert.deepEqual(overlaid(rowsA, overlays)[0], { userId: 'a', name: 'Ada', state: 'deactivated' })
  assert.equal(overlaid(rowsA, overlays)[1], rowsA[1])
})

test('once the server sends rows back, its values show and the overlay is no longer applied', () => {
  const overlays = stage({}, rowsA, 'a', { state: 'deactivated' })
  const refreshed: Row[] = [
    { userId: 'a', name: 'Ada', state: 'active' },
    { userId: 'b', name: 'Bo', state: 'active' },
  ]
  assert.equal(overlaid(refreshed, overlays)[0]!.state, 'active')
})

test('a failed change is unstaged and the server row shows again', () => {
  const overlays = unstage(stage({}, rowsA, 'a', { state: 'deactivated' }), 'a')
  assert.equal(overlaid(rowsA, overlays)[0], rowsA[0])
})

test('two changes over the same rows both stay on screen', () => {
  const first = stage({}, rowsA, 'a', { name: 'Ada L' })
  const both = stage(first, rowsA, 'a', { state: 'deactivated' })
  assert.deepEqual(overlaid(rowsA, both)[0], { userId: 'a', name: 'Ada L', state: 'deactivated' })
})

test('a change made over newer rows does not carry an older overlay forward', () => {
  const stale = stage({}, rowsA, 'a', { name: 'Old name' })
  const newer = [...rowsA]
  const overlays = stage(stale, newer, 'a', { state: 'deactivated' })
  assert.deepEqual(overlaid(newer, overlays)[0], { userId: 'a', name: 'Ada', state: 'deactivated' })
})
