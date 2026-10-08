import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { containsPattern, fragmentsOf, searchTextFrom } from './text-match.ts'

test('a blank search has no fragments, so it filters nothing', () => {
  assert.deepEqual(fragmentsOf(''), [])
  assert.deepEqual(fragmentsOf('   \t '), [])
})

test('fragments are the words typed, trimmed and in the order typed', () => {
  assert.deepEqual(fragmentsOf('  stale  audit '), ['stale', 'audit'])
  assert.deepEqual(fragmentsOf('jane\tdoe'), ['jane', 'doe'])
})

test('a fragment matches anywhere in the text', () => {
  assert.equal(containsPattern('stale'), '%stale%')
})

test('%, _ and backslash in a fragment are escaped so they match themselves', () => {
  assert.equal(containsPattern('100%'), '%100\\%%')
  assert.equal(containsPattern('a_b'), '%a\\_b%')
  assert.equal(containsPattern('c:\\d'), '%c:\\\\d%')
})

test('the search text of a custom record holds its textual fields in field order, and nothing else', () => {
  const object = {
    fields: [
      { key: 'name', type: 'text' },
      { key: 'amount', type: 'number' },
      { key: 'notes', type: 'long_text' },
      { key: 'stage', type: 'select' },
      { key: 'due', type: 'date' },
    ],
  }
  const { sql: text, params } = new PgDialect().sqlToQuery(searchTextFrom(object, sql`"custom"`))
  assert.equal(text, `concat_ws(' ', "custom" ->> $1, "custom" ->> $2, "custom" ->> $3)`)
  assert.deepEqual(params, ['name', 'notes', 'stage'])
})

test('an object with no textual field has empty search text', () => {
  const { sql: text } = new PgDialect().sqlToQuery(searchTextFrom({ fields: [{ key: 'amount', type: 'number' }] }, sql`"custom"`))
  assert.equal(text, `''::text`)
})
