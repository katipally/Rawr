import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StepView } from './automation-list.tsx'
import { stepsComplete } from './steps-complete.ts'

const MAX = 366 * 24 * 60
const filled = { conjunction: 'and' as const, conditions: [{ field: 'name', operator: 'is' as const, value: 'Acme' }] }
const blank = { conjunction: 'and' as const, conditions: [{ field: 'name', operator: 'is' as const, value: '' }] }
const task: StepView = { kind: 'action', type: 'create_task', config: {} }

test('a rule of actions, waits and filled checks is complete', () => {
  assert.equal(stepsComplete([task, { kind: 'delay', amount: '1', unit: 'hours' }, { kind: 'guard', conditions: [filled] }], MAX), true)
  assert.equal(stepsComplete([{ kind: 'guard', conditions: [] }], MAX), true)
})

test('a check with a blank row is not complete', () => {
  assert.equal(stepsComplete([task, { kind: 'guard', conditions: [blank] }], MAX), false)
})

test('a blank row is found inside either arm of a branch, however deep', () => {
  const inner: StepView = { kind: 'branch', conditions: [], matched: [task], otherwise: [{ kind: 'guard', conditions: [blank] }] }
  assert.equal(stepsComplete([{ kind: 'branch', conditions: [filled], matched: [task], otherwise: [inner] }], MAX), false)
  assert.equal(stepsComplete([{ kind: 'branch', conditions: [filled], matched: [task], otherwise: [inner, task] }], MAX), false)
  assert.equal(stepsComplete([{ kind: 'branch', conditions: [filled], matched: [task], otherwise: [task] }], MAX), true)
})

test('a blank row in the branch condition itself is not complete', () => {
  assert.equal(stepsComplete([{ kind: 'branch', conditions: [blank], matched: [task], otherwise: [] }], MAX), false)
})

test('a set-field action with its field cleared is not complete, however deep', () => {
  const cleared: StepView = { kind: 'action', type: 'set_field', config: { field: '', value: 'x' } }
  assert.equal(stepsComplete([cleared], MAX), false)
  assert.equal(stepsComplete([{ kind: 'branch', conditions: [], matched: [], otherwise: [cleared] }], MAX), false)
  assert.equal(stepsComplete([{ kind: 'action', type: 'set_field', config: { field: 'name', value: 'x' } }], MAX), true)
})

test('a wait needs a whole amount from one minute up to the cap, however deep', () => {
  const wait = (amount: string, unit: 'minutes' | 'hours' | 'days'): StepView => ({ kind: 'delay', amount, unit })
  assert.equal(stepsComplete([wait('366', 'days')], MAX), true)
  assert.equal(stepsComplete([wait('367', 'days')], MAX), false)
  assert.equal(stepsComplete([wait('', 'hours')], MAX), false)
  assert.equal(stepsComplete([wait('0', 'minutes')], MAX), false)
  assert.equal(stepsComplete([{ kind: 'branch', conditions: [], matched: [wait('0', 'days')], otherwise: [] }], MAX), false)
})
