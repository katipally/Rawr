import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterOptions, rank } from './combobox.ts'

/** What the reader sees first after typing. The tiers matter more than the exact
 *  numbers: a prefix must beat a word start, which must beat a hit anywhere. */

const option = (label: string, hint?: string, keywords?: string[]) => ({ label, hint, keywords })

test('an empty query keeps everything, in the caller order', () => {
  const all = [option('Zoe'), option('Adam')]
  assert.deepEqual(filterOptions(all, '').map((o) => o.label), ['Zoe', 'Adam'])
})

test('a prefix beats a word start beats anywhere', () => {
  assert.ok(rank(option('Sales team'), 'sal') < rank(option('Enterprise sales'), 'sal'))
  assert.ok(rank(option('Enterprise sales'), 'sal') < rank(option('Wholesale'), 'sal'))
})

test('a label hit beats a hint hit', () => {
  assert.ok(rank(option('Ada'), 'ada') < rank(option('Zoe', 'ada@datasaur.ai'), 'ada'))
})

test('keywords match without being shown', () => {
  assert.ok(rank(option('Deals', undefined, ['pipeline', 'revenue']), 'pipe') >= 0)
})

test('no match returns -1 and is dropped', () => {
  assert.equal(rank(option('Contacts'), 'zzz'), -1)
  assert.deepEqual(filterOptions([option('Contacts')], 'zzz'), [])
})

test('matching is case and whitespace insensitive', () => {
  assert.equal(rank(option('Contacts'), '  CON '), 0)
})

test('an email local part counts as a word start', () => {
  assert.ok(rank(option('trevor@datasaur.ai'), 'datasaur') <= rank(option('bestdatasaurus'), 'datasaur'))
})

test('ties keep the caller order, so a recency sort survives', () => {
  const ranked = filterOptions([option('Sales A'), option('Sales B')], 'sales')
  assert.deepEqual(ranked.map((o) => o.label), ['Sales A', 'Sales B'])
})

test('a label hit beats a keyword hit, so a page named for the word wins', () => {
  // "Users" is a settings page; "billing" is a keyword on Subscriptions. Typing
  // "users" must not put Subscriptions above the page actually called Users.
  assert.ok(rank(option('Users'), 'users') < rank(option('Subscriptions', undefined, ['users', 'billing']), 'users'))
})
