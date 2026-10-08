import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DATE_RANGES } from '@rawr/db/registry'
import type { Condition } from './filter-builder.tsx'
import { groupsComplete, isComplete, isReversed } from './filter-rules.ts'

const row = (operator: Condition['operator'], value?: unknown): Condition => ({ field: 'amount', operator, value })

/** A row counts as finished only when the filter it writes means what it says.
 *  An empty value, half a range or an empty list would reach the compiler as a
 *  condition nobody chose, so each of these must stay unfinished until filled. */
test('a single value is finished once it is typed, and not before', () => {
  assert.equal(isComplete(row('is', '')), false)
  assert.equal(isComplete(row('is')), false)
  assert.equal(isComplete(row('contains', 'Acme')), true)
  assert.equal(isComplete(row('gt', 0)), true)
})

test('a legacy scalar in a list operator is read as one entry', () => {
  assert.equal(isComplete(row('in', 'Lead')), true)
  assert.equal(isComplete(row('in', [])), false)
  assert.equal(isComplete(row('in', ['Lead', ''])), false)
})

test('a range needs both ends, unless it is a rolling range', () => {
  assert.equal(isComplete(row('between', ['', ''])), false)
  assert.equal(isComplete(row('between', ['2026-01-01', ''])), false)
  assert.equal(isComplete(row('between', ['2026-01-01', '2026-02-01'])), true)
  assert.equal(isComplete(row('between', DATE_RANGES[0]!.token)), true)
})

test('a range whose From is after its To is not finished, and says so', () => {
  assert.equal(isReversed(row('between', ['2026-10-06', '2026-10-05'])), true)
  assert.equal(isComplete(row('between', ['2026-10-06', '2026-10-05'])), false)
  assert.equal(isReversed(row('between', ['2026-10-05', '2026-10-05'])), false)
  assert.equal(isReversed(row('between', ['2026-10-05T10:00', '2026-10-05'])), false)
  assert.equal(isReversed(row('between', ['2026-10-05', '2026-10-05T23:00'])), false)
  assert.equal(isReversed(row('between', ['2026-10-05T12:00', '2026-10-05T09:00'])), true)
  assert.equal(isReversed(row('between', ['2026-10-06', '2026-10-05T23:59'])), true)
  assert.equal(isReversed(row('between', [10, 5] as unknown as string[])), false)
  assert.equal(isReversed(row('between', DATE_RANGES[0]!.token)), false)
})

test('an operator that takes no value is finished without one', () => {
  assert.equal(isComplete(row('is_empty')), true)
  assert.equal(isComplete(row('is_not_empty', '')), true)
})

test('a set of groups is finished only when every row in every group is', () => {
  const filled = { conjunction: 'and' as const, conditions: [row('is', 'Acme')] }
  const blank = { conjunction: 'or' as const, conditions: [row('is', '')] }
  assert.equal(groupsComplete([]), true)
  assert.equal(groupsComplete([filled]), true)
  assert.equal(groupsComplete([filled, blank]), false)
  assert.equal(groupsComplete([{ conjunction: 'and', conditions: [] }]), true)
})
