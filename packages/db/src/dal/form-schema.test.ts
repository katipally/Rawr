import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formBlockers, REDIRECT_BLOCKER, webAddress, type FormField } from './form-schema.ts'

test('webAddress accepts absolute http and https addresses and returns the serialized form', () => {
  assert.equal(webAddress('https://a.b/c?x=1'), 'https://a.b/c?x=1')
  assert.equal(webAddress('http://127.0.0.1:8123/cb'), 'http://127.0.0.1:8123/cb')
  assert.equal(webAddress('HTTPS://Example.com'), 'https://example.com/')
  assert.equal(webAddress('  https://x.example  '), 'https://x.example/')
  assert.equal(webAddress('\thttps://x.example\n'), 'https://x.example/')
})

test('webAddress refuses every scheme that can run script or leave the web', () => {
  const bad = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    '\tjavascript:alert(1)',
    '\njavascript:alert(1)',
    'java\nscript:alert(1)',
    'java\tscript:alert(1)',
    'java\rscript:alert(1)',
    '\u0000javascript:alert(1)',
    'data:text/html,x',
    'DATA:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://x.example/',
    'blob:https://x.example/id',
    'mailto:a@b.co',
  ]
  for (const value of bad) assert.equal(webAddress(value), null, JSON.stringify(value))
})

test('webAddress refuses relative, protocol-relative and prose values', () => {
  for (const value of ['//evil.com', '///evil.com', '\\\\evil.com', '/relative', 'relative', 'example.com', 'Thanks. We will be in touch.', 'https:', 'https://', '', '   ']) {
    assert.equal(webAddress(value), null, JSON.stringify(value))
  }
})

const ready = { name: 'Contact', slug: 'contact' }
const fields: FormField[] = [
  { key: 'email', type: 'email', label: 'Email', required: true, mapsTo: 'contact.email', step: 0 },
]

test('formBlockers asks for a full address only in redirect mode', () => {
  const blockers = (successMode: 'message' | 'redirect', successValue: string) =>
    formBlockers({ ...ready, fields, settings: { successMode, successValue } })
  assert.deepEqual(blockers('message', 'Thanks. We will be in touch.'), [])
  assert.deepEqual(blockers('message', 'javascript:alert(1)'), [])
  assert.deepEqual(blockers('redirect', 'https://example.com/thanks'), [])
  for (const value of ['', 'Thanks. We will be in touch.', 'javascript:alert(1)', '//evil.com', 'data:text/html,x']) {
    assert.deepEqual(blockers('redirect', value), [REDIRECT_BLOCKER], JSON.stringify(value))
  }
})
