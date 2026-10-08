import assert from 'node:assert/strict'
import { test } from 'node:test'
import { leastRecentlyAssigned } from './teams.ts'

const at = (iso: string) => new Date(iso)

test('a member never picked goes before anybody who has been picked', () => {
  assert.equal(
    leastRecentlyAssigned([
      { userId: 'a', lastAssignedAt: at('2026-01-01T00:00:00Z') },
      { userId: 'b', lastAssignedAt: null },
    ]),
    'b',
  )
})

test('among members who have been picked, the one picked longest ago goes', () => {
  assert.equal(
    leastRecentlyAssigned([
      { userId: 'a', lastAssignedAt: at('2026-03-01T00:00:00Z') },
      { userId: 'b', lastAssignedAt: at('2026-01-01T00:00:00Z') },
      { userId: 'c', lastAssignedAt: at('2026-02-01T00:00:00Z') },
    ]),
    'b',
  )
})

test('ties on the same instant break on user id, whatever order they arrive in', () => {
  const same = at('2026-01-01T00:00:00Z')
  assert.equal(
    leastRecentlyAssigned([
      { userId: 'c', lastAssignedAt: same },
      { userId: 'a', lastAssignedAt: same },
      { userId: 'b', lastAssignedAt: same },
    ]),
    'a',
  )
  assert.equal(
    leastRecentlyAssigned([
      { userId: 'b', lastAssignedAt: null },
      { userId: 'a', lastAssignedAt: null },
    ]),
    'a',
  )
})

test('a team of one always gives that one member the turn', () => {
  assert.equal(leastRecentlyAssigned([{ userId: 'a', lastAssignedAt: at('2026-01-01T00:00:00Z') }]), 'a')
  assert.equal(leastRecentlyAssigned([{ userId: 'a', lastAssignedAt: null }]), 'a')
})

test('an empty pool has no turn to give', () => {
  assert.equal(leastRecentlyAssigned([]), null)
})

test('repeated picks cycle through every member in turn, and a joiner goes next', () => {
  const turns = new Map<string, Date | null>([
    ['a', null],
    ['b', null],
    ['c', null],
  ])
  const picks: string[] = []
  let clock = 0
  const pick = () => {
    const members = [...turns].map(([userId, lastAssignedAt]) => ({ userId, lastAssignedAt }))
    const chosen = leastRecentlyAssigned(members)
    assert.ok(chosen)
    turns.set(chosen, at(`2026-01-01T00:00:${String(++clock).padStart(2, '0')}Z`))
    picks.push(chosen)
  }

  for (let i = 0; i < 3; i++) pick()
  turns.set('d', null)
  for (let i = 0; i < 4; i++) pick()

  assert.deepEqual(picks, ['a', 'b', 'c', 'd', 'a', 'b', 'c'])
})
