import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FormField } from '@rawr/db'
import { decodeEcho, echoCookiePath, encodeEcho } from './form-echo.ts'

const field = (key: string, type: FormField['type'], label = key): FormField => ({
  key,
  type,
  label,
  required: false,
})
const fields = [field('email', 'email'), field('notes', 'long_text'), field('upload', 'file'), field('ref', 'hidden')]

test('typed answers round trip', () => {
  const raw = encodeEcho(fields, { email: 'a@b.co', notes: 'hello' })
  assert.deepEqual(decodeEcho(fields, raw ?? undefined), { email: 'a@b.co', notes: 'hello' })
})

test('file, hidden, unknown, empty and non-string answers are never stored', () => {
  const raw = encodeEcho(fields, { upload: 'x', ref: 'y', other: 'z', email: '', notes: ['a', 'b'] })
  assert.equal(raw, null)
})

test('a field that looks like a secret is never stored', () => {
  const secret = [field('pin', 'text', 'Account password'), field('api_token', 'text')]
  assert.equal(encodeEcho(secret, { pin: 'hunter2', api_token: 'abc' }), null)
  assert.deepEqual(decodeEcho(secret, JSON.stringify({ pin: 'hunter2', api_token: 'abc' })), {})
})

test('a value is cut to 200 characters', () => {
  const decoded = decodeEcho(fields, encodeEcho(fields, { notes: 'x'.repeat(5000) }) ?? undefined)
  assert.equal(decoded.notes?.length, 200)
})

test('the cookie stays inside the size limit however many answers there are', () => {
  const many = Array.from({ length: 60 }, (_, i) => field(`q${i}`, 'text'))
  const body = Object.fromEntries(many.map((f) => [f.key, 'é'.repeat(200)]))
  const raw = encodeEcho(many, body)
  assert.ok(raw && encodeURIComponent(raw).length <= 3000)
  assert.ok(Object.keys(decodeEcho(many, raw ?? undefined)).length < 60)
})

test('a forged cookie fills only the form own boxes and only with strings', () => {
  const forged = JSON.stringify({ email: 'a@b.co', upload: 'x', ref: 'y', evil: 'z', notes: 7 })
  assert.deepEqual(decodeEcho(fields, forged), { email: 'a@b.co' })
})

test('unreadable or oversized cookies decode to nothing', () => {
  assert.deepEqual(decodeEcho(fields, undefined), {})
  assert.deepEqual(decodeEcho(fields, '{not json'), {})
  assert.deepEqual(decodeEcho(fields, '[]'), {})
  assert.deepEqual(decodeEcho(fields, `{"email":"${'a'.repeat(4000)}"}`), {})
})

test('only a form address becomes a cookie path', () => {
  assert.equal(echoCookiePath('acme/contact'), '/form/acme/contact')
  assert.equal(echoCookiePath('0b1c2d3e-4f50-6789-abcd-ef0123456789'), '/form/0b1c2d3e-4f50-6789-abcd-ef0123456789')
  assert.equal(echoCookiePath('a/b/c'), null)
  assert.equal(echoCookiePath('a;path=/'), null)
  assert.equal(echoCookiePath('../x'), null)
  assert.equal(echoCookiePath(''), null)
})
