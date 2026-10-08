import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keeps, type Row } from './associations.ts'

const row = (name: string | null, detail: string | null = null): Row => ({ id: 'r', name, detail, created_at: null })

test('an association search needs every word typed, each in the name or the detail, in any order', () => {
  const acme = row('Acme Corp', 'Austin, TX')
  assert.ok(keeps(acme, 'corp acme'))
  assert.ok(keeps(acme, 'austin acme'))
  assert.ok(!keeps(acme, 'acme boston'))
})

test('an association search matches a fragment mid-word and a blank search keeps every row', () => {
  assert.ok(keeps(row('Acme Corp'), 'cme'))
  assert.ok(keeps(row(null, null), undefined))
  assert.ok(keeps(row(null, null), ''))
})
