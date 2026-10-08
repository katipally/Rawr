import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assigneeFilterUsers, pickableUsers } from './pickable-users.ts'

const people = [
  { id: 'a', label: 'Ada', deactivated: false },
  { id: 'b', label: 'Ben', deactivated: true },
  { id: 'c', label: 'Cy', deactivated: false },
]

test('a new assignment offers active members only, in order', () => {
  assert.deepEqual(pickableUsers(people), [
    { id: 'a', label: 'Ada' },
    { id: 'c', label: 'Cy' },
  ])
  assert.deepEqual(pickableUsers(people, null), pickableUsers(people))
})

test('a deactivated member stored as the current value is kept, labelled', () => {
  assert.deepEqual(pickableUsers(people, 'b'), [
    { id: 'a', label: 'Ada' },
    { id: 'c', label: 'Cy' },
    { id: 'b', label: 'Ben (deactivated)' },
  ])
})

test('an unknown or active current value adds nothing', () => {
  assert.deepEqual(pickableUsers(people, 'zzz'), pickableUsers(people))
  assert.deepEqual(pickableUsers(people, 'a'), pickableUsers(people))
})

test('an empty member list gives an empty picker, even with a current value', () => {
  assert.deepEqual(pickableUsers([]), [])
  assert.deepEqual(pickableUsers([], 'b'), [])
})

test('the assignee filter drops the viewer and labels deactivated members', () => {
  assert.deepEqual(assigneeFilterUsers(people, 'a'), [
    { id: 'b', label: 'Ben (deactivated)' },
    { id: 'c', label: 'Cy' },
  ])
})

test('the assignee filter keeps everyone when the viewer is unknown', () => {
  assert.equal(assigneeFilterUsers(people, null).length, 3)
})
