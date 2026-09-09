import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_TOOLSETS, TOOLSETS, parseToolsets } from './toolsets.ts'

const sorted = (set: ReadonlySet<string>) => [...set].sort()

test('no query is the default set', () => {
  assert.deepEqual(sorted(parseToolsets(null)), [...DEFAULT_TOOLSETS].sort())
  assert.deepEqual(sorted(parseToolsets('')), [...DEFAULT_TOOLSETS].sort())
  assert.deepEqual(sorted(parseToolsets('   ')), [...DEFAULT_TOOLSETS].sort())
})

test('all is every toolset', () => {
  assert.deepEqual(sorted(parseToolsets('all')), Object.keys(TOOLSETS).sort())
})

test('a named list replaces the default, and always keeps core', () => {
  assert.deepEqual(sorted(parseToolsets('mail,forms')), ['core', 'forms', 'mail'])
  // crm is the other default and is gone: the client asked for two things.
  assert.equal(parseToolsets('mail,forms').has('crm'), false)
})

test('a leading plus adds to the default set', () => {
  assert.deepEqual(sorted(parseToolsets('+mail')), ['core', 'crm', 'mail'])
})

test('a name nobody has is ignored, never a connection with no tools', () => {
  assert.deepEqual(sorted(parseToolsets('nonsense')), [...DEFAULT_TOOLSETS].sort())
  assert.deepEqual(sorted(parseToolsets('mail,nonsense')), ['core', 'mail'])
})

test('every default names a real toolset', () => {
  for (const key of DEFAULT_TOOLSETS) assert.ok(key in TOOLSETS, `${key} is not a toolset`)
})
