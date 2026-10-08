import assert from 'node:assert/strict'
import { test } from 'node:test'
import { railInitial } from './rail-initial.ts'

const targets = [
  { key: 'contact', hasCompanyLink: true },
  { key: 'deal', hasCompanyLink: true },
  { key: 'company', hasCompanyLink: false },
]

test('a record created from a company page starts with that company on every object that has one', () => {
  assert.deepEqual(railInitial(targets, 'co-1'), {
    contact: { company_id: 'co-1' },
    deal: { company_id: 'co-1' },
  })
})

test('an object without a company link is never pre-linked', () => {
  assert.equal('company' in railInitial(targets, 'co-1'), false)
})

test('a record with no live company pre-links nothing', () => {
  assert.deepEqual(railInitial(targets, null), {})
})

test('no targets gives no initial values', () => {
  assert.deepEqual(railInitial([], 'co-1'), {})
})
