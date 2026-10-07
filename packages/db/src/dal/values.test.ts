import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TYPE_META, type FieldType } from '../registry/types.ts'
import type { RegistryField } from './registry.ts'
import { filterValue, ValueError } from './values.ts'

const field = (type: FieldType, over: Partial<RegistryField> = {}): RegistryField => ({
  id: `id-${type}`,
  key: type,
  label: 'Amount',
  type,
  storage: 'column',
  columnName: type,
  isRequired: false,
  conditional: null,
  isCustom: false,
  isSystem: false,
  trackChanges: false,
  options: [],
  helpText: null,
  groupName: null,
  position: 0,
  operators: TYPE_META[type].operators,
  ...over,
})

const refused = (f: RegistryField, input: unknown, said: RegExp) =>
  assert.throws(() => filterValue(f, input), (cause) => cause instanceof ValueError && said.test(cause.message), String(input))

test('a number is accepted as typed, trimmed, signed or in scientific notation', () => {
  const amount = field('currency')
  for (const input of ['0', '5000', ' 12.5 ', '-3', '+7', '.5', '5.', '1e3', '-1.5E-2', 42, -0.5, 1e21]) {
    assert.equal(filterValue(amount, input), typeof input === 'string' ? input.trim() : input)
  }
})

test('a number field refuses what Postgres would reject, naming the field and the value', () => {
  for (const type of ['number', 'currency', 'percent', 'rating'] as const) {
    for (const input of ['abc', '', '   ', '1,000', '$5', '0x10', '1_000', '--1', '1e', 'NaN', 'Infinity', '-Infinity', '12abc', 'ሃ፩', true, NaN, Infinity]) {
      refused(field(type), input, /^Amount: ".*" is not a number\.$/)
    }
  }
})

test('a literal beyond anything a number can hold is refused as too large', () => {
  refused(field('number'), '1e999', /^Amount: "1e999" is too large a number\.$/)
  refused(field('number'), '9'.repeat(400), /too large a number/)
  assert.equal(filterValue(field('number'), '9'.repeat(300)), '9'.repeat(300))
})

test('a long bad value is cut in the sentence so the screen stays readable', () => {
  assert.throws(
    () => filterValue(field('number'), 'x'.repeat(5000)),
    (cause) => cause instanceof ValueError && cause.message.length < 120,
  )
})

test('a boolean takes the spellings a person uses and refuses the rest', () => {
  const flag = field('boolean')
  for (const [input, expected] of [[true, true], [false, false], ['true', true], ['No', false], [' yes ', true], ['0', false]] as const) {
    assert.equal(filterValue(flag, input), expected, String(input))
  }
  for (const input of ['maybe', 'abc', ' ', '2']) refused(flag, input, /^Amount: ".*" is not a yes or a no\.$/)
})

test('a date has to be a real day', () => {
  const day = field('date')
  assert.equal(filterValue(day, '2026-10-07'), '2026-10-07')
  assert.equal(filterValue(day, ' 2024-02-29 '), '2024-02-29')
  for (const input of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-1-1', '07/10/2026', 'tomorrow', '@yesterday', '', '   ', '2026-10-07T10:00', 20261007]) {
    refused(day, input, /^Amount: ".*" is not a date\. Use YYYY-MM-DD\.$/)
  }
})

test('a datetime takes a day or a moment, with or without an offset', () => {
  const moment = field('datetime')
  for (const input of ['2026-10-07', '2026-10-07T09:30', '2026-10-07 09:30:15', '2026-10-07T09:30:15.250Z', '2026-10-07T09:30:00+05:30']) {
    assert.equal(filterValue(moment, input), input)
  }
  for (const input of ['2026-10-07T25:00', '2026-02-30T10:00', '2026-10-07T10', 'noon', 'été', '']) {
    refused(moment, input, /is not a date and time/)
  }
})

test('a date object is kept and an invalid one is refused', () => {
  const at = new Date('2026-10-07T00:00:00Z')
  assert.equal(filterValue(field('datetime'), at), at)
  assert.equal(filterValue(field('date'), at), at)
  refused(field('date'), new Date('nope'), /is not a date/)
})

test('a person or a record is a uuid, however it is cased', () => {
  const owner = field('user')
  const id = '3F2504E0-4F89-41D3-9A0C-0305E82C3301'
  assert.equal(filterValue(owner, ` ${id} `), id)
  for (const input of ['abc', '3f2504e0-4f89-41d3-9a0c', 'me', '1', 'ä'.repeat(36)]) {
    refused(field('relation'), input, /has to be picked from the list, not typed\.$/)
  }
})

test('a choice in a column of its own must be one of its choices, spelled as the field spells it', () => {
  const consent = field('select', { options: ['Allowed', 'Never'] })
  assert.equal(filterValue(consent, 'allowed'), 'Allowed')
  refused(consent, 'sometimes', /^Amount: "sometimes" is not one of its choices: Allowed, Never\.$/)
})

test('a removed choice on a jsonb field still filters, and matches nothing', () => {
  const status = field('select', { storage: 'jsonb', columnName: null, options: ['Planned'] })
  assert.equal(filterValue(status, 'Retired'), 'Retired')
  assert.equal(filterValue(field('select', { options: [] }), 'anything'), 'anything')
})

test('text is compared as typed, and a list or an object is not one value', () => {
  for (const type of ['text', 'email', 'long_text', 'url', 'multi_select'] as const) {
    assert.equal(filterValue(field(type), '  é ñ 日本 '), '  é ñ 日本 ')
  }
  for (const input of [['a', 'b'], { a: 1 }, [[1]]]) refused(field('text'), input, /takes one value in a filter/)
})
