import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OPERATORS } from '@rawr/db/registry'
import type { Choice } from './field-input.tsx'
import { summarize } from './quick-filter-summary.ts'

const people: Choice[] = [
  { id: '@me', label: 'Me' },
  { id: 'u-2', label: 'Dana Ortiz' },
]
const asIs = (value: string) => value
const day = (value: string) => (value === '@today' ? 'Today' : `D(${value})`)

test('the owner chip reads a person by name, including Me for the current user', () => {
  assert.equal(summarize({ field: 'owner_id', operator: 'is', value: '@me' }, people, asIs), 'Me')
  assert.equal(summarize({ field: 'owner_id', operator: 'in', value: ['@me', 'u-2'] }, people, asIs), 'Me +1')
  assert.equal(summarize({ field: 'owner_id', operator: 'is_not', value: 'u-2' }, people, asIs), 'Not Dana Ortiz')
})

test('every operator the engine has reads as words, never as a generic label', () => {
  for (const operator of OPERATORS) {
    const value = operator === 'between' ? ['2026-01-01', '2026-02-01'] : operator === 'is_empty' || operator === 'is_not_empty' ? undefined : 'x'
    const text = summarize({ field: 'f', operator, value }, people, day)
    assert.notEqual(text, 'Filtered', operator)
    assert.notEqual(text, '', operator)
  }
})

test('a date chip formats its day and keeps Today', () => {
  assert.equal(summarize({ field: 'created_at', operator: 'on_or_after', value: '@today' }, [], day), 'Today')
  assert.equal(summarize({ field: 'created_at', operator: 'on_or_after', value: '2026-03-04' }, [], day), 'Since D(2026-03-04)')
  assert.equal(summarize({ field: 'created_at', operator: 'before', value: '2026-03-04' }, [], day), 'Before D(2026-03-04)')
})

test('a text chip quotes what was typed and says the negated and empty cases', () => {
  assert.equal(summarize({ field: 'industry', operator: 'contains', value: 'saas' }, [], asIs), '“saas”')
  assert.equal(summarize({ field: 'industry', operator: 'not_contains', value: 'saas' }, [], asIs), 'Not “saas”')
  assert.equal(summarize({ field: 'industry', operator: 'is_empty' }, [], asIs), 'Empty')
})
