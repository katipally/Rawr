import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RegistryObject } from './registry.ts'
import { suggestMapping } from './imports.ts'
import { csvCell } from './values.ts'

const contacts = (fields: [key: string, label: string][]): RegistryObject =>
  ({
    key: 'contact',
    fields: fields.map(([key, label]) => ({ key, label, isSystem: false, type: 'text' })),
  }) as unknown as RegistryObject

test('a header an export guarded with a formula apostrophe still maps to its field', () => {
  const object = contacts([['x', '@x'], ['score', '=Score']])
  assert.deepEqual(suggestMapping(object, [csvCell('@x')]), { "'@x": 'x' })
  assert.deepEqual(suggestMapping(object, [csvCell('=Score')]), { "'=Score": 'score' })
})

test('a guarded header maps to the field with that exact label, not a look-alike', () => {
  const object = contacts([['plan', 'Plan'], ['plan_sign', '+Plan']])
  assert.deepEqual(suggestMapping(object, ['Plan', csvCell('+Plan')]), { Plan: 'plan', "'+Plan": 'plan_sign' })
})
