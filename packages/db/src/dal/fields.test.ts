import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { FIELD_TYPES, IMMUTABLE_PARSER, TYPE_META } from '../registry/types.ts'
import { fieldExpression } from './query.ts'
import type { RegistryField, RegistryObject } from './registry.ts'
import { dropIndexSql, isPermanentSqlError, planFieldIndex, unindexableReason, type IndexTarget } from './fields.ts'

const FIELD_ID = '7f5f2c58-2e0e-4f0e-9a4a-6a3b2f5a1c11'
const OBJECT_ID = '0b9c1d52-8a3e-4c47-b1f0-3d5e6a7b8c9d'

const target = (over: Partial<IndexTarget> = {}): IndexTarget => ({
  fieldId: FIELD_ID,
  fieldKey: 'format',
  fieldType: 'text',
  objectKey: 'asset',
  objectId: OBJECT_ID,
  isCustomObject: true,
  ...over,
})

const sqlOf = (expression: ReturnType<typeof fieldExpression>) =>
  (expression as unknown as { queryChunks: { value: string[] }[] }).queryChunks.map((c) => c.value.join('')).join('')

/** Quotes, parentheses, spaces, the table alias and a `::text` over text (which the
 *  parser drops) are how the two spellings differ; what the planner compares is the
 *  same tree, so this keeps only what is in it. */
const bare = (text: string) =>
  text.replace(/"asset"\./g, '').replace(/::text$/, '').replace(/[()\s"]/g, '')

test('a custom object index names the field by its id, so two accounts never meet', () => {
  const a = planFieldIndex(target())
  const b = planFieldIndex(target({ fieldId: '11111111-2222-4333-8444-555555555555', objectId: '66666666-7777-4888-8999-aaaaaaaaaaaa' }))
  assert.equal(a.name, 'hot_cr_7f5f2c582e0e4f0e9a4a6a3b2f5a1c11')
  assert.notEqual(a.name, b.name)
  assert.ok(a.name.length <= 63)
})

test('a custom object index is on custom_record and partial on its one object', () => {
  const { create } = planFieldIndex(target())
  assert.match(create, /on custom_record /)
  assert.ok(create.endsWith(`where object_id = '${OBJECT_ID}'`), create)
  assert.ok(!create.includes('"asset"'), create)
})

test('a core object keeps the statement it always had', () => {
  const { name, create } = planFieldIndex(target({ isCustomObject: false, objectKey: 'contact', fieldKey: 'plan' }))
  assert.equal(name, 'hot_contact_plan')
  assert.equal(
    create,
    `create index concurrently if not exists "hot_contact_plan" on "contact" (((custom->>'plan'))) where custom ? 'plan'`,
  )
})

test('every type the custom index accepts is built on the expression the query side emits', () => {
  for (const type of FIELD_TYPES) {
    if (unindexableReason(type, true)) continue
    const object = { key: 'asset', isCustom: true } as RegistryObject
    const queried = fieldExpression(object, { key: 'format', type, storage: 'jsonb' } as RegistryField)
    const { create } = planFieldIndex(target({ fieldType: type }))
    const indexed = create.slice(create.indexOf('custom_record') + 'custom_record'.length, create.indexOf(' where '))
    assert.equal(bare(indexed), bare(sqlOf(queried)), type)
  }
})

test('numbers and booleans carry the cast their filters use, text carries none', () => {
  assert.match(planFieldIndex(target({ fieldType: 'number' })).create, /\(custom ->> 'format'\)::numeric/)
  assert.match(planFieldIndex(target({ fieldType: 'rating' })).create, /::numeric/)
  assert.match(planFieldIndex(target({ fieldType: 'boolean' })).create, /::boolean/)
  assert.doesNotMatch(planFieldIndex(target({ fieldType: 'select' })).create, /::/)
})

test('a date and a datetime are indexed through the immutable parsers, never a cast', () => {
  const date = planFieldIndex(target({ fieldType: 'date' })).create
  const moment = planFieldIndex(target({ fieldType: 'datetime' })).create
  assert.match(date, /\(\(public\.stored_date\(custom ->> 'format'\)\)\) where object_id = /)
  assert.match(moment, /\(\(public\.stored_timestamptz\(custom ->> 'format'\)\)\) where object_id = /)
  assert.doesNotMatch(date + moment, /::date|::timestamptz/)
})

test('only a custom object reads a date through the parser, a core object keeps its cast', () => {
  for (const [type, cast] of [['date', 'date'], ['datetime', 'timestamptz']] as const) {
    const field = { key: 'due', type, storage: 'jsonb' } as RegistryField
    const custom = sqlOf(fieldExpression({ key: 'asset', isCustom: true } as RegistryObject, field))
    assert.equal(custom, `${IMMUTABLE_PARSER[cast]}("asset"."custom" ->> 'due')`)
    assert.equal(sqlOf(fieldExpression({ key: 'contact', isCustom: false } as RegistryObject, field)), `("contact"."custom" ->> 'due')::${cast}`)
  }
})

test('every parser the query side uses is an immutable function the migrations create', () => {
  const dir = new URL('../../migrations/', import.meta.url)
  const sqlText = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n')
  for (const name of Object.values(IMMUTABLE_PARSER)) {
    const create = sqlText.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replace('.', '\\.')}\\([^)]*\\)[^$]*\\$\\$`))
    assert.ok(create, `${name} is not created by a migration`)
    assert.match(create[0], /\bIMMUTABLE\b/, name)
    assert.doesNotMatch(create[0], /\b(STABLE|VOLATILE)\b/, name)
  }
})

test('multi_select and json cannot be indexed on a custom object, and say why', () => {
  for (const type of ['multi_select', 'json'] as const) {
    assert.match(unindexableReason(type, true) ?? '', /cannot be indexed on a custom object/, type)
    assert.throws(() => planFieldIndex(target({ fieldType: type })), /cannot be indexed/, type)
    assert.equal(unindexableReason(type, false), null, `${type} on a core object is unchanged`)
  }
  assert.match(unindexableReason('multi_select', true) ?? '', /multi select/)
})

test('every field type is either indexable or refused, never half built', () => {
  for (const type of FIELD_TYPES) {
    const refused = unindexableReason(type, true) !== null
    assert.equal(refused, TYPE_META[type].jsonbCast === 'jsonb', type)
    if (!refused) assert.doesNotThrow(() => planFieldIndex(target({ fieldType: type })), type)
  }
})

test('keys and ids that could close a quote never reach the statement', () => {
  for (const fieldKey of ["x'; drop table contact; --", 'Format', 'a b', '', 'select']) {
    assert.throws(() => planFieldIndex(target({ fieldKey })), Error, fieldKey)
    assert.throws(() => planFieldIndex(target({ fieldKey, isCustomObject: false, objectKey: 'contact' })), Error, fieldKey)
  }
  assert.throws(() => planFieldIndex(target({ fieldId: "x' or '1'='1" })), /no valid id/)
  assert.throws(() => planFieldIndex(target({ objectId: 'not-a-uuid' })), /no valid id/)
  assert.throws(() => planFieldIndex(target({ isCustomObject: false, objectKey: 'contact"; --' })), Error)
})

test('a core name Postgres would fold is refused instead of recorded under the wrong spelling', () => {
  assert.throws(
    () => planFieldIndex(target({ isCustomObject: false, objectKey: 'contact', fieldKey: 'a'.repeat(59) })),
    /too long/,
  )
  assert.doesNotThrow(() => planFieldIndex(target({ isCustomObject: false, objectKey: 'contact', fieldKey: 'a'.repeat(50) })))
})

test('only an index this system named can be dropped', () => {
  assert.equal(dropIndexSql('hot_cr_7f5f2c582e0e4f0e9a4a6a3b2f5a1c11'), 'drop index concurrently if exists "hot_cr_7f5f2c582e0e4f0e9a4a6a3b2f5a1c11"')
  assert.equal(dropIndexSql('hot_contact_plan'), 'drop index concurrently if exists "hot_contact_plan"')
  for (const name of ['contact_pkey', 'hot_x"; drop table contact; --', 'hot_', `hot_${'a'.repeat(60)}`, 'HOT_x']) {
    assert.throws(() => dropIndexSql(name), /will not be dropped/, name)
  }
})

test('a statement Postgres rejects as written is permanent, a dropped connection is not', () => {
  assert.equal(isPermanentSqlError({ code: '42P01' }), true)
  assert.equal(isPermanentSqlError({ code: '42P17' }), true)
  assert.equal(isPermanentSqlError({ code: '42883' }), true)
  assert.equal(isPermanentSqlError({ code: '57014' }), false)
  assert.equal(isPermanentSqlError({ code: 'ECONNRESET' }), false)
  assert.equal(isPermanentSqlError(new Error('boom')), false)
  assert.equal(isPermanentSqlError(null), false)
})
