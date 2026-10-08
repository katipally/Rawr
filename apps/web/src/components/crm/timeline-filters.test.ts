import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assignedChipLabel, authorsFromParam, searchEmptyHint, withFilters } from './timeline-filters.ts'

const people = ['u1', 'u2', 'u3']
const names: Record<string, string> = { u1: 'Ana', u2: 'Ben' }
const count = (n: number) => String(n)

test('the who parameter keeps only people on this timeline', () => {
  assert.deepEqual(authorsFromParam('u2,ghost,u1', people), ['u2', 'u1'])
  assert.deepEqual(authorsFromParam(null, people), [])
})

test('the filters survive a round trip through the address', () => {
  const link = withFilters('?record=1&type=call,note', ['call', 'note'], ['u1', 'u3'])
  assert.equal(new URLSearchParams(link).get('record'), '1')
  assert.deepEqual(authorsFromParam(new URLSearchParams(link).get('who'), people), ['u1', 'u3'])
  assert.equal(new URLSearchParams(link).get('type'), 'call,note')
})

test('clearing the people filter removes who from the address', () => {
  assert.equal(new URLSearchParams(withFilters('?who=u1&type=note', ['note'], [])).has('who'), false)
})

test('the chip names one person and counts two or more', () => {
  const labelOf = (id: string) => names[id]
  assert.equal(assignedChipLabel(['u1'], labelOf, count), 'Assigned to Ana')
  assert.equal(assignedChipLabel(['u1', 'u2'], labelOf, count), 'Assigned to (2)')
  assert.equal(assignedChipLabel([], labelOf, count), 'Assigned to')
})

test('the search hint points at Load older only when there is something older', () => {
  assert.match(searchEmptyHint(true), /Load older/)
  assert.equal(searchEmptyHint(false), 'Nothing on this record matches that search.')
})
