import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupableField, groupableFields, groupingToSave } from './board.ts'
import type { RegistryField, RegistryObject } from './registry.ts'

const field = (key: string, type: RegistryField['type'], options: string[] = []): RegistryField =>
  ({ id: `id-${key}`, key, label: key, type, options, storage: 'column', columnName: key } as RegistryField)

const fields = [
  field('name', 'text'),
  field('stage_id', 'relation'),
  field('owner_id', 'user'),
  field('deal_type', 'select', ['New', 'Renewal']),
]
const deal = { key: 'deal', fields, byKey: new Map(fields.map((f) => [f.key, f])) } as unknown as RegistryObject

test('a board can group by the stage, a select or an owner, and by nothing else', () => {
  assert.deepEqual(groupableFields(deal).map((f) => f.key), ['stage_id', 'owner_id', 'deal_type'])
})

test('a refused grouping names the fields that work', () => {
  assert.equal(groupableField(deal, 'owner_id').key, 'owner_id')
  assert.throws(() => groupableField(deal, 'name'), /cannot be grouped by "name"\. Try one of: stage_id, owner_id, deal_type\./)
})

test('a board saves the grouping it shows, and saves nothing when it fell back', () => {
  assert.equal(groupingToSave('deal_type', false), 'deal_type')
  assert.equal(groupingToSave('stage_id', false), null)
  assert.equal(groupingToSave('stage_id', true), undefined)
  assert.equal(groupingToSave('deal_type', true), undefined)
})
