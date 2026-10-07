import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CORE_VIEWS } from '../registry/core.ts'
import type { RegistryField, RegistryObject } from './registry.ts'
import { DEFAULT_VIEW_SLUG, fallbackView } from './views.ts'

/** A custom object has no seeded view, and everything that reads a view's columns
 *  (the toolbar, export, "Save as new view") has to see a real set for it. */

const objectWith = (key: string, fieldKeys: string[], isCustom: boolean): RegistryObject => {
  const fields = fieldKeys.map((fieldKey) => ({ key: fieldKey }) as RegistryField)
  return {
    id: `object-${key}`,
    key,
    nameSingular: key,
    namePlural: key,
    icon: null,
    isCustom,
    table: isCustom ? 'custom_record' : key,
    labelFieldKey: null,
    fields,
    byKey: new Map(fields.map((field) => [field.key, field])),
  }
}

const keys = (count: number) => Array.from({ length: count }, (_, index) => `f${index}`)

test('a custom object shows its first eight fields', () => {
  const view = fallbackView(objectWith('asset', keys(12), true), DEFAULT_VIEW_SLUG)
  assert.deepEqual(view.columns, keys(8))
})

test('a custom object with fewer than eight fields shows all of them', () => {
  assert.deepEqual(fallbackView(objectWith('asset', keys(3), true), DEFAULT_VIEW_SLUG).columns, keys(3))
})

test('a custom object with no fields has no columns to show', () => {
  assert.deepEqual(fallbackView(objectWith('asset', [], true), DEFAULT_VIEW_SLUG).columns, [])
})

test('a core object keeps the columns its seeded view names', () => {
  const view = fallbackView(objectWith('contact', keys(12), false), CORE_VIEWS.contact[0]!.slug)
  assert.deepEqual(view.columns, CORE_VIEWS.contact[0]!.columns)
})
