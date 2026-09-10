import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveAppBase, skipsFixtures } from './env.ts'

/** Where the worker points its internal calls. An empty variable resolving to
 *  "undefined/api/..." is how six job families dead-lettered quietly. */

test('an address somebody set is used as given', () => {
  assert.equal(resolveAppBase({ RAWR_INTERNAL_URL: 'https://rawr.example', PORT: '10000' }), 'https://rawr.example')
})

test('nothing set falls back to the loopback address and the default port', () => {
  assert.equal(resolveAppBase({}), 'http://127.0.0.1:3000')
})

test('the port the app was told to listen on is the one used', () => {
  assert.equal(resolveAppBase({ PORT: '10000' }), 'http://127.0.0.1:10000')
})

test('a variable set and then cleared falls back like an absent one', () => {
  assert.equal(resolveAppBase({ RAWR_INTERNAL_URL: '', PORT: '10000' }), 'http://127.0.0.1:10000')
  assert.equal(resolveAppBase({ RAWR_INTERNAL_URL: '   ', PORT: '10000' }), 'http://127.0.0.1:10000')
})

/** Whether the dispatchers step over the fixture tenants. Unset, they do not:
 *  local import testing has no tenants but the fixtures. */

test('the switch is on only when it is set to exactly 1', () => {
  assert.equal(skipsFixtures({ RAWR_WORKER_SKIPS_FIXTURES: '1' }), true)
  assert.equal(skipsFixtures({ RAWR_WORKER_SKIPS_FIXTURES: ' 1 ' }), true)
})

test('unset, empty, or any other value leaves every tenant in', () => {
  assert.equal(skipsFixtures({}), false)
  assert.equal(skipsFixtures({ RAWR_WORKER_SKIPS_FIXTURES: '' }), false)
  assert.equal(skipsFixtures({ RAWR_WORKER_SKIPS_FIXTURES: '0' }), false)
  assert.equal(skipsFixtures({ RAWR_WORKER_SKIPS_FIXTURES: 'true' }), false)
})
