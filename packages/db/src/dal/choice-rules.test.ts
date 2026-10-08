import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renameChoicesInFormFields, renameChoicesInRules } from './choice-rules.ts'

const map = (pairs: [string, string][]) => new Map(pairs)

test('a condition on the renamed property moves in every group, and no other property does', () => {
  const filters = [
    { conjunction: 'and', conditions: [{ field: 'stage', operator: 'is', value: 'Old' }, { field: 'region', operator: 'is', value: 'Old' }] },
    { conjunction: 'or', conditions: [{ field: 'stage', operator: 'is_not', value: 'Old' }] },
  ]
  assert.deepEqual(renameChoicesInRules(filters, 'stage', map([['Old', 'New']])), [
    { conjunction: 'and', conditions: [{ field: 'stage', operator: 'is', value: 'New' }, { field: 'region', operator: 'is', value: 'Old' }] },
    { conjunction: 'or', conditions: [{ field: 'stage', operator: 'is_not', value: 'New' }] },
  ])
})

test('an "is any of" list renames each choice and keeps the rest', () => {
  const rule = [{ field: 'stage', operator: 'in', value: ['Old', 'Keep'] }]
  assert.deepEqual(renameChoicesInRules(rule, 'stage', map([['Old', 'New']])), [{ field: 'stage', operator: 'in', value: ['New', 'Keep'] }])
})

test('a swap of two choices in one rename is one pass, so nothing is renamed twice', () => {
  const rules = [
    { field: 'stage', operator: 'is', value: 'A' },
    { field: 'stage', operator: 'in', value: ['A', 'B'] },
  ]
  assert.deepEqual(renameChoicesInRules(rules, 'stage', map([['A', 'B'], ['B', 'A']])), [
    { field: 'stage', operator: 'is', value: 'B' },
    { field: 'stage', operator: 'in', value: ['B', 'A'] },
  ])
})

test('values that are not choices are left as they are', () => {
  const rules = [
    { field: 'stage', operator: 'is', value: 0 },
    { field: 'stage', operator: 'is', value: null },
    { field: 'stage', operator: 'in', value: [1, 'Old', true] },
    { field: 'stage', operator: 'is' },
  ]
  assert.deepEqual(renameChoicesInRules(rules, 'stage', map([['Old', 'New']])), [
    { field: 'stage', operator: 'is', value: 0 },
    { field: 'stage', operator: 'is', value: null },
    { field: 'stage', operator: 'in', value: [1, 'New', true] },
    { field: 'stage', operator: 'is' },
  ])
})

test('a substring search is typed by a person and stays as typed', () => {
  const rule = [{ field: 'stage', operator: 'contains', value: 'Old' }]
  assert.deepEqual(renameChoicesInRules(rule, 'stage', map([['Old', 'New']])), rule)
})

test('automation steps: a guard, both arms of a branch and a set-field action are reached', () => {
  const steps = [
    { kind: 'guard', conditions: [{ conjunction: 'and', conditions: [{ field: 'stage', operator: 'is', value: 'Old' }] }] },
    {
      kind: 'branch',
      conditions: [{ conjunction: 'and', conditions: [{ field: 'stage', operator: 'is', value: 'Old' }] }],
      matched: [{ kind: 'action', type: 'set_field', config: { field: 'stage', value: 'Old' } }],
      otherwise: [{ kind: 'action', type: 'set_field', config: { field: 'other', value: 'Old' } }],
    },
    { kind: 'delay', minutes: 5 },
  ]
  assert.deepEqual(renameChoicesInRules(steps, 'stage', map([['Old', 'New']])), [
    { kind: 'guard', conditions: [{ conjunction: 'and', conditions: [{ field: 'stage', operator: 'is', value: 'New' }] }] },
    {
      kind: 'branch',
      conditions: [{ conjunction: 'and', conditions: [{ field: 'stage', operator: 'is', value: 'New' }] }],
      matched: [{ kind: 'action', type: 'set_field', config: { field: 'stage', value: 'New' } }],
      otherwise: [{ kind: 'action', type: 'set_field', config: { field: 'other', value: 'Old' } }],
    },
    { kind: 'delay', minutes: 5 },
  ])
})

test('the input is not mutated', () => {
  const rule = [{ field: 'stage', operator: 'is', value: 'Old' }]
  renameChoicesInRules(rule, 'stage', map([['Old', 'New']]))
  assert.equal(rule[0]!.value, 'Old')
})

test('a rule with nothing to rename comes back equal', () => {
  const rule = { conjunction: 'and', conditions: [{ field: 'stage', operator: 'is', value: 'Other' }] }
  assert.deepEqual(renameChoicesInRules(rule, 'stage', map([['Old', 'New']])), rule)
})

test('a form copies the choices of the field that maps to the property, and the rule that names that field', () => {
  const fields = [
    {
      key: 'stage_q',
      mapsTo: 'contact.stage',
      options: [
        { value: 'Old', label: 'Old' },
        { value: 'Old2', label: 'Old2 label' },
        { value: 'Keep', label: 'Keep' },
      ],
    },
    { key: 'follow', visibleIf: { field: 'stage_q', equals: 'Old' } },
    { key: 'region_q', mapsTo: 'contact.region', options: [{ value: 'Old', label: 'Old' }] },
    { key: 'other_follow', visibleIf: { field: 'region_q', equals: 'Old' } },
  ]
  assert.deepEqual(renameChoicesInFormFields(fields, 'contact.stage', map([['Old', 'New'], ['Old2', 'New2']])), [
    {
      key: 'stage_q',
      mapsTo: 'contact.stage',
      options: [
        { value: 'New', label: 'New' },
        { value: 'New2', label: 'Old2 label' },
        { value: 'Keep', label: 'Keep' },
      ],
    },
    { key: 'follow', visibleIf: { field: 'stage_q', equals: 'New' } },
    { key: 'region_q', mapsTo: 'contact.region', options: [{ value: 'Old', label: 'Old' }] },
    { key: 'other_follow', visibleIf: { field: 'region_q', equals: 'Old' } },
  ])
})
