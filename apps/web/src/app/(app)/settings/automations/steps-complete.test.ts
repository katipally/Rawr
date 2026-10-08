import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StepView } from './automation-list.tsx'
import { stepsComplete } from './steps-complete.ts'

const filled = { conjunction: 'and' as const, conditions: [{ field: 'name', operator: 'is' as const, value: 'Acme' }] }
const blank = { conjunction: 'and' as const, conditions: [{ field: 'name', operator: 'is' as const, value: '' }] }
const task: StepView = { kind: 'action', type: 'create_task', config: {} }

test('a rule of actions, waits and filled checks is complete', () => {
  assert.equal(stepsComplete([task, { kind: 'delay', minutes: 60 }, { kind: 'guard', conditions: [filled] }]), true)
  assert.equal(stepsComplete([{ kind: 'guard', conditions: [] }]), true)
})

test('a check with a blank row is not complete', () => {
  assert.equal(stepsComplete([task, { kind: 'guard', conditions: [blank] }]), false)
})

test('a blank row is found inside either arm of a branch, however deep', () => {
  const inner: StepView = { kind: 'branch', conditions: [], matched: [task], otherwise: [{ kind: 'guard', conditions: [blank] }] }
  assert.equal(stepsComplete([{ kind: 'branch', conditions: [filled], matched: [task], otherwise: [inner] }]), false)
  assert.equal(stepsComplete([{ kind: 'branch', conditions: [filled], matched: [task], otherwise: [inner, task] }]), false)
  assert.equal(stepsComplete([{ kind: 'branch', conditions: [filled], matched: [task], otherwise: [task] }]), true)
})

test('a blank row in the branch condition itself is not complete', () => {
  assert.equal(stepsComplete([{ kind: 'branch', conditions: [blank], matched: [task], otherwise: [] }]), false)
})

test('a set-field action with its field cleared is not complete, however deep', () => {
  const cleared: StepView = { kind: 'action', type: 'set_field', config: { field: '', value: 'x' } }
  assert.equal(stepsComplete([cleared]), false)
  assert.equal(stepsComplete([{ kind: 'branch', conditions: [], matched: [], otherwise: [cleared] }]), false)
  assert.equal(stepsComplete([{ kind: 'action', type: 'set_field', config: { field: 'name', value: 'x' } }]), true)
})
