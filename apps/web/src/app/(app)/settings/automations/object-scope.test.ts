import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FilterField } from '~/components/crm/filter-builder.tsx'
import type { StepView } from './automation-list.tsx'
import { type ObjectScope, scopeRule } from './object-scope.ts'

const field = (key: string, label: string): FilterField => ({ key, label, type: 'text', options: [], operators: ['is'] })
const contact = [field('first_name', 'First name'), field('last_name', 'Last name'), field('name', 'Name')]
const company = [field('name', 'Name'), field('domain', 'Domain')]
const scope = (filterFields: FilterField[], dates: ObjectScope['dates'], settable: string[], hasInbox: boolean): ObjectScope => ({
  filterFields,
  settable,
  dates,
  hasInbox,
})
const contactScope = scope(contact, [{ key: 'birthday', label: 'Birthday' }], ['first_name', 'last_name', 'name', 'birthday'], true)
const companyScope = scope(company, [{ key: 'founded_on', label: 'Founded on' }], ['name', 'domain', 'founded_on'], false)
const noTrigger = {}

const row = (key: string) => ({ field: key, operator: 'is' as const, value: 'x' })
const group = (...keys: string[]) => ({ conjunction: 'and' as const, conditions: keys.map(row) })
const task: StepView = { kind: 'action', type: 'create_task', config: {} }
const setField = (key: string): StepView => ({ kind: 'action', type: 'set_field', config: { field: key, value: 'v' } })

test('a condition on a field the new object has is kept', () => {
  const out = scopeRule({ conditions: [group('name')], steps: [], triggerConfig: noTrigger }, companyScope, contactScope)
  assert.deepEqual(out.conditions, [group('name')])
  assert.deepEqual(out.removed, [])
})

test('a condition on a field the new object lacks is dropped and named by its old label', () => {
  const out = scopeRule({ conditions: [group('first_name', 'domain')], steps: [], triggerConfig: noTrigger }, companyScope, contactScope)
  assert.deepEqual(out.conditions, [group('domain')])
  assert.deepEqual(out.removed, ['First name'])
})

test('a group emptied by the drop is removed, as the builder itself writes it', () => {
  const out = scopeRule({ conditions: [group('first_name'), group('name')], steps: [], triggerConfig: noTrigger }, companyScope, contactScope)
  assert.deepEqual(out.conditions, [group('name')])
})

test('checks and branches are pruned at any depth, and only their own conditions', () => {
  const steps: StepView[] = [
    { kind: 'guard', conditions: [group('last_name', 'domain')] },
    {
      kind: 'branch',
      conditions: [group('first_name')],
      matched: [task],
      otherwise: [{ kind: 'branch', conditions: [group('last_name', 'name')], matched: [], otherwise: [{ kind: 'guard', conditions: [group('first_name')] }] }],
    },
  ]
  const out = scopeRule({ conditions: [], steps, triggerConfig: noTrigger }, companyScope, contactScope)
  assert.deepEqual(out.steps, [
    { kind: 'guard', conditions: [group('domain')] },
    {
      kind: 'branch',
      conditions: [],
      matched: [task],
      otherwise: [{ kind: 'branch', conditions: [group('name')], matched: [], otherwise: [{ kind: 'guard', conditions: [] }] }],
    },
  ])
  assert.deepEqual(out.removed, ['Last name', 'First name', 'Last name', 'First name'])
})

test('a set-field action on a field the new object lacks is cleared and named by its label', () => {
  const out = scopeRule({ conditions: [], steps: [setField('last_name'), setField('domain')], triggerConfig: noTrigger }, companyScope, contactScope)
  assert.deepEqual(out.steps, [{ kind: 'action', type: 'set_field', config: { field: '', value: 'v' } }, setField('domain')])
  assert.deepEqual(out.removed, ['Last name'])
})

test('a set-field action is cleared inside a branch, at any depth', () => {
  const steps: StepView[] = [{ kind: 'branch', conditions: [], matched: [], otherwise: [{ kind: 'branch', conditions: [], matched: [setField('first_name')], otherwise: [] }] }]
  const out = scopeRule({ conditions: [], steps, triggerConfig: noTrigger }, companyScope, contactScope)
  assert.deepEqual(out.steps, [{ kind: 'branch', conditions: [], matched: [], otherwise: [{ kind: 'branch', conditions: [], matched: [setField('')], otherwise: [] }] }])
  assert.deepEqual(out.removed, ['First name'])
})

test('a set-field action with no field picked yet is left alone and reports nothing', () => {
  const steps: StepView[] = [setField('')]
  const out = scopeRule({ conditions: [], steps, triggerConfig: noTrigger }, companyScope, contactScope)
  assert.deepEqual(out.steps, steps)
  assert.deepEqual(out.removed, [])
})

test('a date trigger on a date the new object lacks is cleared and named by its old label', () => {
  const out = scopeRule({ conditions: [], steps: [], triggerConfig: { fieldKey: 'birthday', days: '3' } }, companyScope, contactScope)
  assert.deepEqual(out.triggerConfig, { fieldKey: '', days: '3' })
  assert.deepEqual(out.removed, ['Birthday'])
})

test('a date trigger on a date the new object has is kept', () => {
  const triggerConfig = { fieldKey: 'founded_on' }
  const out = scopeRule({ conditions: [], steps: [], triggerConfig }, companyScope, companyScope)
  assert.deepEqual(out.triggerConfig, triggerConfig)
  assert.deepEqual(out.removed, [])
})

test('a rule with nothing to drop comes back unchanged', () => {
  const steps: StepView[] = [task, { kind: 'delay', amount: '1', unit: 'hours' }, setField('name')]
  assert.deepEqual(scopeRule({ conditions: [group('name')], steps, triggerConfig: noTrigger }, contactScope, contactScope), {
    conditions: [group('name')],
    steps,
    triggerConfig: {},
    removed: [],
  })
})

const email: StepView = { kind: 'action', type: 'send_email', config: { templateId: 't', mailboxId: 'm' } }

test('a contact-only action is dropped on a company and named by its label', () => {
  const out = scopeRule({ conditions: [], steps: [task, email], triggerConfig: noTrigger }, companyScope, contactScope)
  assert.deepEqual(out.steps, [task])
  assert.deepEqual(out.removed, ['Send an email'])
})

test('a contact-only action is kept on a contact', () => {
  const out = scopeRule({ conditions: [], steps: [email], triggerConfig: noTrigger }, contactScope, contactScope)
  assert.deepEqual(out.steps, [email])
  assert.deepEqual(out.removed, [])
})

test('a contact-only action inside a branch is dropped at any depth', () => {
  const steps: StepView[] = [
    { kind: 'branch', conditions: [], matched: [email], otherwise: [{ kind: 'branch', conditions: [], matched: [], otherwise: [email, task] }] },
  ]
  const out = scopeRule({ conditions: [], steps, triggerConfig: noTrigger }, companyScope, contactScope)
  assert.deepEqual(out.steps, [{ kind: 'branch', conditions: [], matched: [], otherwise: [{ kind: 'branch', conditions: [], matched: [], otherwise: [task] }] }])
  assert.deepEqual(out.removed, ['Send an email', 'Send an email'])
})
