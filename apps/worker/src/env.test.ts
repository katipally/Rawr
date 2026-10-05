import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveAppBase, scheduleOverrides, skipsFixtures } from './env.ts'

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

/** A job's schedule can be changed from the environment, and a mistake there stops
 *  the worker rather than quietly running the job at a rate nobody chose. */

test('nothing set leaves every schedule as shipped', () => {
  assert.deepEqual(scheduleOverrides({}), {})
  assert.deepEqual(scheduleOverrides({ RAWR_WORKER_SCHEDULES: '  ' }), {})
})

test('a named job takes the cron it is given', () => {
  assert.deepEqual(scheduleOverrides({ RAWR_WORKER_SCHEDULES: '{"import.dispatch": " */5 * * * * "}' }), {
    'import.dispatch': '*/5 * * * *',
  })
})

test('anything that is not an object of five field crons is refused', () => {
  for (const bad of ['not json', '[]', '"x"', '{"a": 5}', '{"a": "* * *"}', '{"a": "every minute"}']) {
    assert.throws(() => scheduleOverrides({ RAWR_WORKER_SCHEDULES: bad }), /RAWR_WORKER_SCHEDULES/, bad)
  }
})
