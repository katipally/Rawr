import assert from 'node:assert/strict'
import { test } from 'node:test'
import { idempotencyKey, LATEST, negotiate, withData } from './wire.ts'

const MINUTE = 60_000
const at = 1_800_000_000_000 - (1_800_000_000_000 % MINUTE)
const key = (args: Record<string, unknown>, tool = 'crm_records_create', token = 'tok_a', now = at) =>
  idempotencyKey({}, args, token, tool, now)

test('a version we speak is answered as asked', () => {
  assert.equal(negotiate('2025-06-18'), '2025-06-18')
})

test('a version we do not speak is answered with the newest one, whatever shape it came in', () => {
  assert.equal(LATEST, '2026-07-28')
  for (const asked of ['2024-11-05', '1999-01-01', 42, null, undefined]) {
    assert.equal(negotiate(asked), LATEST, String(asked))
  }
})

test('the derived key is the same for the same arguments in any key order', () => {
  assert.equal(key({ a: 1, b: { x: 1, y: [2, { p: 1, q: 2 }] } }), key({ b: { y: [2, { q: 2, p: 1 }], x: 1 }, a: 1 }))
})

test('the derived key holds for one minute and changes after it', () => {
  assert.equal(key({ a: 1 }, 'crm_records_create', 'tok_a', at), key({ a: 1 }, 'crm_records_create', 'tok_a', at + MINUTE - 1))
  assert.notEqual(key({ a: 1 }, 'crm_records_create', 'tok_a', at), key({ a: 1 }, 'crm_records_create', 'tok_a', at + MINUTE))
})

test('different tools, arguments or tokens never share a derived key', () => {
  const keys = new Set([
    key({ a: 1 }),
    key({ a: 2 }),
    key({ a: 1, b: null }),
    key({ a: '1' }),
    key({ a: 1 }, 'crm_records_update'),
    key({ a: 1 }, 'crm_records_create', 'tok_b'),
  ])
  assert.equal(keys.size, 6)
})

test('a key the client sends is used as it is, in whichever place it is sent', () => {
  assert.equal(idempotencyKey({ idempotencyKey: ' mine ' }, {}, 't', 'x', at), 'mine')
  assert.equal(idempotencyKey({ _meta: { 'io.modelcontextprotocol/idempotencyKey': 'meta' } }, {}, 't', 'x', at), 'meta')
  assert.equal(idempotencyKey({}, { idempotency_key: 'args' }, 't', 'x', at), 'args')
  assert.equal(idempotencyKey({}, { idempotency_key: 'k'.repeat(500) }, 't', 'x', at).length, 200)
})

test('small data is appended to the sentence as compact JSON', () => {
  assert.equal(withData('Created a contact.', undefined), 'Created a contact.')
  assert.equal(withData('Created a contact.', { id: 'c1', tags: ['a'] }), 'Created a contact.\n{"id":"c1","tags":["a"]}')
})

test('data past 4000 characters is cut and says so', () => {
  const [sentence, body, note] = withData('Listed.', { rows: 'x'.repeat(10_000) }).split('\n')
  assert.equal(sentence, 'Listed.')
  assert.equal(body?.length, 4000)
  assert.equal(note, '(truncated, see structuredContent)')
})
