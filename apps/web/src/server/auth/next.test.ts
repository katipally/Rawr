import assert from 'node:assert/strict'
import { test } from 'node:test'
import { safeNext } from './next.ts'

/** One line, three call sites, and the only thing standing between a sign-in link
 *  and an open redirect. */

test('a same-origin path survives', () => {
  assert.equal(safeNext('/contacts/datasaur/home'), '/contacts/datasaur/home')
  assert.equal(safeNext('/oauth/authorize?client_id=x&state=y'), '/oauth/authorize?client_id=x&state=y')
})

test('anything that could leave this origin falls back to the front door', () => {
  for (const hostile of [
    '//evil.example',
    '///evil.example',
    'https://evil.example',
    'http://evil.example',
    'javascript:alert(1)',
    'evil.example',
    '',
    null,
    undefined,
  ]) {
    assert.equal(safeNext(hostile), '/', String(hostile))
  }
})
