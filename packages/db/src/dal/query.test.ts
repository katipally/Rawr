import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OPEN_STAGE, TYPE_META, type Operator } from '../registry/types.ts'
import type { RegistryField, RegistryObject } from './registry.ts'
import {
  compileFilters,
  fieldExpression,
  orderPlan,
  parseFilters,
  parseSorts,
  scopeFor,
  type Condition,
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
  conditional: null,
  isCustom: false,
  isSystem: false,
  trackChanges: false,
  options: [],
  helpText: null,
  groupName: null,
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

const scope = scopeFor('user-1', 'UTC', new Date('2026-09-03T10:00:00Z'))

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

test('a filter value that does not fit its field is refused as a sentence before any SQL', () => {
  const only = (condition: Condition) => () => compile([{ conjunction: 'and', conditions: [condition] }])
  assert.throws(only({ field: 'amount', operator: 'gt', value: 'abc' }), /^ValueError: amount: "abc" is not a number\.$/m)
  assert.throws(only({ field: 'created_at', operator: 'after', value: 'soon' }), /not a date and time/)
  assert.throws(only({ field: 'owner_id', operator: 'in', value: ['@me', 'nobody'] }), /"nobody" has to be picked from the list/)
  assert.throws(only({ field: 'amount', operator: 'between', value: ['1', 'two'] }), /"two" is not a number/)
  assert.throws(only({ field: 'uttr_pipeline', operator: 'is', value: 'perhaps' }), /not a yes or a no/)
  assert.throws(only({ field: 'email', operator: 'is', value: ['a', 'b'] }), /takes one value in a filter/)
})

test('valid values and every operator on them compile as before', () => {
  const run = (condition: Condition) => built(compile([{ conjunction: 'and', conditions: [condition] }]))
  assert.deepEqual(run({ field: 'amount', operator: 'gte', value: ' 1e3 ' }).params, ['1e3'])
  assert.deepEqual(run({ field: 'amount', operator: 'between', value: [10, '20'] }).params, [10, '20'])
  assert.deepEqual(run({ field: 'created_at', operator: 'on_or_before', value: '2026-09-03' }).params, ['2026-09-03', 'UTC'])
  assert.deepEqual(run({ field: 'owner_id', operator: 'is', value: '@me' }).params, ['user-1'])
  assert.equal(run({ field: 'amount', operator: 'is_empty', value: 'not even looked at' }).params.length, 0)
  assert.equal(run({ field: 'amount', operator: 'gt', value: '' }).text, '(false)')
})

test('a boolean filter takes the "true" and "false" the Yes and No picker sends', () => {
  const run = (value: unknown) =>
    built(compile([{ conjunction: 'and', conditions: [{ field: 'uttr_pipeline', operator: 'is', value }] }]))
  assert.deepEqual(run('true').params, [true])
  assert.deepEqual(run('false').params, [false])
})

test('@me resolves to the caller and an anonymous caller matches nothing', () => {
  const mine: FilterGroup[] = [
    { conjunction: 'and', conditions: [{ field: 'owner_id', operator: 'is', value: '@me' }] },
  ]
  assert.ok(compileFilters(contact, mine, scope))
  // Saying "false" beats quietly dropping the filter and showing every record.
  assert.equal(built(compileFilters(contact, mine, scopeFor(null, 'UTC'))).text, '(false)')
})

test('@open_stage matches a deal with no stage or a stage that is not closed, read when the query runs', () => {
  const deal: RegistryObject = { ...contact, id: 'object-deal', key: 'deal', table: 'deal', fields: [field({ key: 'stage_id', type: 'relation' })] }
  deal.byKey = new Map(deal.fields.map((f) => [f.key, f]))
  const open = built(compileFilters(deal, [{ conjunction: 'and', conditions: [{ field: 'stage_id', operator: 'is', value: OPEN_STAGE }] }], scope)).text
  assert.match(open, /"deal"\."stage_id" is null or "deal"\."stage_id" in \(select s\.id from pipeline_stage s where not s\.is_closed_won and not s\.is_closed_lost\)/)
  const notOpen = built(compileFilters(deal, [{ conjunction: 'and', conditions: [{ field: 'stage_id', operator: 'is_not', value: OPEN_STAGE }] }], scope)).text
  assert.match(notOpen, /^\(not \(/)
})

test('@today is the day in the account zone, not in UTC', () => {
  // 3 AM UTC on the 3rd is still the evening of the 2nd on the Pacific coast, and
  // already the afternoon of the 3rd in Auckland.
  const at = new Date('2026-09-03T03:00:00Z')
  assert.equal(scopeFor(null, 'UTC', at).today, '2026-09-03')
  assert.equal(scopeFor(null, 'America/Los_Angeles', at).today, '2026-09-02')
  assert.equal(scopeFor(null, 'Pacific/Auckland', at).today, '2026-09-03')
})

test('a rolling date range resolves on the day the query runs, in the account zone', () => {
  const at = new Date('2026-10-01T03:00:00Z')
  const pacific = scopeFor(null, 'America/Los_Angeles', at)
  const { text, params } = built(
    compileFilters(contact, [{ conjunction: 'and', conditions: [{ field: 'created_at', operator: 'between', value: '@last_month' }] }], pacific),
  )
  // Still September 30th in Los Angeles, so last month is August, between that
  // zone's midnights.
  assert.ok(text.includes('at time zone'), text)
  assert.deepEqual(params, ['2026-08-01', 'America/Los_Angeles', '2026-08-31', 'America/Los_Angeles'])
  // A fixed range saved before the tokens existed is still two bound days.
  const fixed = built(compile([{ conjunction: 'and', conditions: [{ field: 'created_at', operator: 'between', value: ['2026-01-01', '2026-01-31'] }] }]))
  assert.deepEqual(fixed.params, ['2026-01-01', 'UTC', '2026-01-31', 'UTC'])
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

test('a custom object filters and sorts a date through the parser, a core object through the cast', () => {
  const due = field({ key: 'due', type: 'date', storage: 'jsonb', columnName: null, isCustom: true })
  const seen = field({ key: 'seen', type: 'datetime', storage: 'jsonb', columnName: null, isCustom: true })
  const make = (key: string, isCustom: boolean): RegistryObject => ({
    ...contact,
    key,
    isCustom,
    fields: [due, seen],
    byKey: new Map([due, seen].map((f) => [f.key, f])),
  })
  const conditions: Condition[] = [
    { field: 'due', operator: 'on_or_after', value: '2026-01-01' },
    { field: 'seen', operator: 'between', value: ['2026-01-01', '2026-01-31'] },
  ]
  const run = (object: RegistryObject) => ({
    filter: built(compileFilters(object, [{ conjunction: 'and', conditions }], scope)).text,
    order: built(orderPlan(object, [{ key: 'seen', direction: 'desc' }]).orderBy).text,
  })

  const asset = run(make('asset', true))
  assert.ok(asset.filter.includes(`public.stored_date("asset"."custom" ->> 'due') >=`), asset.filter)
  assert.ok(asset.filter.includes(`public.stored_timestamptz("asset"."custom" ->> 'seen') >=`), asset.filter)
  assert.ok(asset.order.startsWith(`public.stored_timestamptz("asset"."custom" ->> 'seen') desc nulls last`), asset.order)
  assert.doesNotMatch(asset.filter + asset.order, /\)::(date|timestamptz)\b/)

  const core = run(make('contact', false))
  assert.ok(core.filter.includes(`("contact"."custom" ->> 'due')::date >=`), core.filter)
  assert.ok(core.order.startsWith(`("contact"."custom" ->> 'seen')::timestamptz desc`), core.order)
})

test('is_not and not_contains treat a null as "not that value"', () => {
  for (const operator of ['is_not', 'not_contains'] as Operator[]) {
    const { text } = built(
      compile([{ conjunction: 'and', conditions: [{ field: 'email', operator, value: 'a@b.com' }] }]),
    )
    assert.ok(text.includes('is null'), `${operator}: ${text}`)
  }
})

test('contains needs every word typed, in any order, and a % or _ matches itself', () => {
  const words = built(compile([{ conjunction: 'and', conditions: [{ field: 'email', operator: 'contains', value: ' doe  jane ' }] }]))
  assert.deepEqual(words.params.filter((p) => typeof p === 'string' && p.startsWith('%')), ['%doe%', '%jane%'])
  const literal = built(compile([{ conjunction: 'and', conditions: [{ field: 'email', operator: 'contains', value: '100%_x' }] }]))
  assert.ok(literal.params.includes('%100\\%\\_x%'), JSON.stringify(literal.params))
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

// ------------------------------------------------------ dates on the account clock

const sqlOf = (condition: Condition, zone = 'America/Los_Angeles', object: RegistryObject = contact) =>
  built(compileFilters(object, [{ conjunction: 'and', conditions: [condition] }], scopeFor(null, zone, new Date('2026-10-07T12:00:00Z'))))

test('a datetime is a whole day in the account zone, and is not is its exact complement', () => {
  const on = sqlOf({ field: 'created_at', operator: 'is', value: '2026-10-07' })
  assert.deepEqual(on.params, ['2026-10-07', 'America/Los_Angeles', '2026-10-07', 'America/Los_Angeles'])
  assert.match(on.text, />= \(\(\$\?::date\)::timestamp at time zone \$\?\) and .* < \(\(\$\?::date \+ 1\)::timestamp at time zone \$\?\)/, on.text)
  const not = sqlOf({ field: 'created_at', operator: 'is_not', value: '2026-10-07' })
  assert.ok(not.text.startsWith('("contact"."created_at" is null or') || not.text.startsWith('(("contact"."created_at" is null or'), not.text)
})

test('a typed time on a datetime day is read as the day, and before/after use the day boundary', () => {
  assert.deepEqual(sqlOf({ field: 'created_at', operator: 'before', value: '2026-10-07T14:30' }).params, ['2026-10-07', 'America/Los_Angeles'])
  assert.match(sqlOf({ field: 'created_at', operator: 'before', value: '2026-10-07' }).text, /"contact"\."created_at" < \(/)
  assert.match(sqlOf({ field: 'created_at', operator: 'after', value: '2026-10-07' }).text, /"contact"\."created_at" >= \(/)
  assert.match(sqlOf({ field: 'created_at', operator: 'on_or_before', value: '2026-10-07' }).text, /"contact"\."created_at" < \(/)
  assert.match(sqlOf({ field: 'created_at', operator: 'on_or_after', value: '2026-10-07' }).text, /"contact"\."created_at" >= \(/)
})

test('a custom range on a datetime keeps both days whole: From is a midnight, To runs to the next one', () => {
  const range = sqlOf({ field: 'created_at', operator: 'between', value: ['2026-10-01', '2026-10-07'] })
  assert.deepEqual(range.params, ['2026-10-01', 'America/Los_Angeles', '2026-10-07', 'America/Los_Angeles'])
  assert.match(range.text, />= \(\(\$\?::date\)::timestamp at time zone \$\?\) and .* < /, range.text)
})

test('a custom range with a typed time keeps the time as an exact bound, in the zone or its own offset', () => {
  const typed = sqlOf({ field: 'created_at', operator: 'between', value: ['2026-10-01T09:00', '2026-10-07T23:30'] })
  assert.deepEqual(typed.params, ['2026-10-01T09:00', 'America/Los_Angeles', '2026-10-07T23:30', 'America/Los_Angeles'])
  assert.match(typed.text, /<= \(\$\?::timestamp at time zone \$\?\)/, typed.text)
  const offset = sqlOf({ field: 'created_at', operator: 'between', value: ['2026-10-01', '2026-10-07T23:30Z'] })
  assert.ok(offset.text.includes('$?::timestamptz'), offset.text)
})

test('an open custom range has one bound, and an empty one matches nothing', () => {
  const from = sqlOf({ field: 'due_on', operator: 'between', value: ['2026-10-01', ''] }, 'UTC', dateOnly)
  assert.equal(from.text, '(("contact"."due_on" >= $?))')
  assert.deepEqual(from.params, ['2026-10-01'])
  const to = sqlOf({ field: 'created_at', operator: 'between', value: ['', '2026-10-07'] })
  assert.ok(to.text.includes('<') && !to.text.includes('>='), to.text)
  assert.equal(sqlOf({ field: 'created_at', operator: 'between', value: ['', ''] }).text, '(false)')
})

test('a date field keeps "is" as a plain day comparison, with no zone', () => {
  const is = sqlOf({ field: 'due_on', operator: 'is', value: '2026-10-07' }, 'America/Los_Angeles', dateOnly)
  assert.equal(is.text, '("contact"."due_on" = $?)')
  assert.deepEqual(is.params, ['2026-10-07'])
})

const dateOnly: RegistryObject = {
  ...contact,
  fields: [...FIELDS, field({ key: 'due_on', type: 'date' })],
  byKey: new Map([...FIELDS, field({ key: 'due_on', type: 'date' })].map((f) => [f.key, f])),
}
