import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conditionalCycle, type Conditional } from './conditional.ts'

const on = (field: string): Conditional => ({ conjunction: 'and', conditions: [{ field, operator: 'is_not_empty' }] })

test('a rule that leads back to its own property is a cycle, with the path', () => {
  const rules = new Map<string, Conditional | null>([['b', on('a')]])
  assert.deepEqual(conditionalCycle('a', on('b'), rules), ['a', 'b', 'a'])
})

test('a longer loop is found through the properties between', () => {
  const rules = new Map<string, Conditional | null>([
    ['b', on('c')],
    ['c', on('a')],
  ])
  assert.deepEqual(conditionalCycle('a', on('b'), rules), ['a', 'b', 'c', 'a'])
})

test('a chain that ends at a property with no rule is not a cycle', () => {
  const rules = new Map<string, Conditional | null>([
    ['b', on('c')],
    ['c', null],
  ])
  assert.equal(conditionalCycle('a', on('b'), rules), null)
})

test('a property the rule names more than once does not loop the search', () => {
  const rules = new Map<string, Conditional | null>([
    ['b', on('d')],
    ['c', on('d')],
    ['d', null],
  ])
  const rule: Conditional = { conjunction: 'or', conditions: [on('b').conditions[0]!, on('c').conditions[0]!] }
  assert.equal(conditionalCycle('a', rule, rules), null)
})
