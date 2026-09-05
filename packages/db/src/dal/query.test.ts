import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TYPE_META, type Operator } from '../registry/types.ts'
import type { RegistryField, RegistryObject } from './registry.ts'
import {
  compileFilters,
  fieldExpression,
  orderPlan,
  parseFilters,
  parseSorts,
  scopeFor,
  type FilterGroup,
} from './query.ts'

/** Filters arrive from a URL and from saved-view json, both of which a person can
 *  hand-edit, and they end up in SQL. These cover the two properties that matter:
 *  nothing unrecognised survives the parse, and nothing user-typed reaches the
 *  statement unquoted. */

const field = (over: Partial<RegistryField> & Pick<RegistryField, 'key' | 'type'>): RegistryField => ({
  id: `id-${over.key}`,
  label: over.key,
  storage: 'column',
  columnName: over.key,
  isRequired: false,
  isCustom: false,
  isSystem: false,
  trackChanges: false,
  options: [],
  helpText: null,
  position: 0,
  operators: TYPE_META[over.type].operators,
  ...over,
})

const FIELDS = [
  field({ key: 'email', type: 'email' }),
  field({ key: 'owner_id', type: 'user' }),
  field({ key: 'created_at', type: 'datetime' }),
  field({ key: 'amount', type: 'currency' }),
  field({ key: 'uttr_pipeline', type: 'boolean', storage: 'jsonb', columnName: null, isCustom: true }),
  field({ key: 'products', type: 'multi_select', storage: 'jsonb', columnName: null, isCustom: true }),
]

const contact: RegistryObject = {
  id: 'object-contact',
  key: 'contact',
  nameSingular: 'Contact',
  namePlural: 'Contacts',
  icon: null,
  isCustom: false,
  table: 'contact',
  labelFieldKey: null,
  fields: FIELDS,
  byKey: new Map(FIELDS.map((f) => [f.key, f])),
}

const scope = scopeFor('user-1', new Date('2026-09-03T10:00:00Z'))

/** The SQL a builder produced, with bound values rendered as placeholders rather
 *  than inlined. That separation is the whole point: anything a person typed must
 *  show up in `params` and never in `text`. */
const built = (node: { queryChunks: unknown[] } | undefined): { text: string; params: unknown[] } => {
  const params: unknown[] = []
  const render = (chunk: unknown): string => {
    if (Array.isArray(chunk)) return chunk.map(render).join('')
    const nested = (chunk as { queryChunks?: unknown[] })?.queryChunks
    if (nested) return render(nested)
    // A StringChunk is literal SQL text and holds its parts as an array.
    const literal = (chunk as { value?: unknown })?.value
    if (Array.isArray(literal)) return literal.join('')
    // Anything else is a value the caller passed in, which the driver binds.
    params.push(chunk)
    return '$?'
  }
  return { text: node ? render(node.queryChunks) : '', params }
}

// -------------------------------------------------------------------- parsing

test('parseFilters drops anything it does not recognise', () => {
  for (const input of [null, undefined, 'a string', 42, {}, [null], [{}], [{ conditions: 'no' }], [{ conditions: [] }]]) {
    assert.deepEqual(parseFilters(input), [], JSON.stringify(input))
  }
})

test('parseFilters accepts a bare condition and a bare list as one AND group', () => {
  const bare = parseFilters([{ field: 'email', operator: 'is', value: 'a@b.com' }])
  assert.deepEqual(bare, [
    { conjunction: 'and', conditions: [{ field: 'email', operator: 'is', value: 'a@b.com' }] },
  ])
  // A saved view written by hand is almost always a nested list.
  const list = parseFilters([[{ field: 'email', operator: 'is_empty' }]])
  assert.equal(list[0]?.conjunction, 'and')
  assert.equal(list[0]?.conditions.length, 1)
})

test('parseFilters keeps only conditions that name a field and an operator', () => {
  const groups = parseFilters([
    {
      conjunction: 'or',
      conditions: [
        { field: 'email', operator: 'is', value: 'a@b.com' },
        { field: 'email' },
        { operator: 'is' },
        'nonsense',
      ],
    },
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.conjunction, 'or')
  assert.equal(groups[0]?.conditions.length, 1)
})

test('parseSorts defaults an unknown direction to desc and drops keyless entries', () => {
  assert.deepEqual(parseSorts([{ key: 'created_at', direction: 'sideways' }, { direction: 'asc' }, 7]), [
    { key: 'created_at', direction: 'desc' },
  ])
})

// ------------------------------------------------------------------ compiling

const compile = (groups: FilterGroup[]) => compileFilters(contact, groups, scope)

test('an unknown field is refused rather than compiled', () => {
  assert.throws(
    () => compile([{ conjunction: 'and', conditions: [{ field: 'not_a_field', operator: 'is', value: 'x' }] }]),
    /not_a_field/,
  )
})

test('an operator the type does not support is refused, naming the type', () => {
  assert.throws(
    () => compile([{ conjunction: 'and', conditions: [{ field: 'created_at', operator: 'contains', value: 'x' }] }]),
    /contains.*datetime/s,
  )
})

test('a value a person typed is bound, never interpolated', () => {
  const hostile = "x'; drop table contact --"
  const { text, params } = built(
    compile([{ conjunction: 'and', conditions: [{ field: 'email', operator: 'is', value: hostile }] }]),
  )
  assert.ok(!text.includes('drop table'), text)
  assert.deepEqual(params, [hostile])
})

test('@me resolves to the caller and an anonymous caller matches nothing', () => {
  const mine: FilterGroup[] = [
    { conjunction: 'and', conditions: [{ field: 'owner_id', operator: 'is', value: '@me' }] },
  ]
  assert.ok(compileFilters(contact, mine, scope))
  // Saying "false" beats quietly dropping the filter and showing every record.
  assert.equal(built(compileFilters(contact, mine, scopeFor(null))).text, '(false)')
})

test('an empty group and an empty filter set compile to nothing at all', () => {
  assert.equal(compile([]), undefined)
  assert.equal(compile([{ conjunction: 'and', conditions: [] }]), undefined)
})

test('a jsonb field casts, and a jsonb array is matched by containment', () => {
  // The cast is not optional: a number in jsonb sorts as text without it, and the
  // hot index is built on this exact expression or Postgres will not use it.
  const cast = built(fieldExpression(contact, FIELDS[4]!)).text
  assert.ok(cast.includes('"custom" ->>'), cast)
  assert.ok(cast.includes('::boolean'), cast)
  // multi_select is held as a json array, so "in" is containment not equality.
  const { text } = built(
    compile([{ conjunction: 'and', conditions: [{ field: 'products', operator: 'in', value: ['OCR', 'Audio'] }] }]),
  )
  assert.ok(text.includes('?|'), text)
})

test('is_not and not_contains treat a null as "not that value"', () => {
  for (const operator of ['is_not', 'not_contains'] as Operator[]) {
    const { text } = built(
      compile([{ conjunction: 'and', conditions: [{ field: 'email', operator, value: 'a@b.com' }] }]),
    )
    assert.ok(text.includes('is null'), `${operator}: ${text}`)
  }
})

// --------------------------------------------------------------------- paging

test('with no sort the plan is keyset on the id alone', () => {
  const plan = orderPlan(contact, [])
  assert.equal(plan.cursorValue, null)
  assert.match(built(plan.orderBy).text, /"contact"\."id" desc/)
})

test('a sorted plan is nulls last in both directions and tiebreaks on the id', () => {
  for (const direction of ['asc', 'desc'] as const) {
    const plan = orderPlan(contact, [{ key: 'created_at', direction }])
    const order = built(plan.orderBy).text
    assert.ok(order.includes(`${direction} nulls last`), order)
    assert.ok(order.includes('"id" desc'), order)
    assert.equal(plan.cursorValue, 'created_at')
  }
})

test('a cursor on a null sort value pages by id, not by comparing to null', () => {
  const plan = orderPlan(contact, [{ key: 'amount', direction: 'desc' }])
  const nullCursor = built(plan.keysetWhere({ value: null, id: 'abc' }))
  assert.ok(nullCursor.text.includes('is null'), nullCursor.text)
  assert.deepEqual(nullCursor.params, ['abc'])
  const valued = built(plan.keysetWhere({ value: 100, id: 'abc' }))
  assert.ok(valued.text.includes('is null'), 'nulls sort last, so they come after any value')
})
