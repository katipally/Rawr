import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HUBS as DB_HUBS } from '@rawr/db'
import { HUBS, HUB_HINT, HUBS_WITHOUT_SCREENS } from './hubs.ts'

/** The client copy of the hub list. If it drifts from the database's, a grant the
 *  grid offers is one the server has never heard of, or vice versa. */
test('the client hub list matches the data access layer', () => {
  assert.deepEqual([...HUBS], [...DB_HUBS])
})

test('every hub has a hint and every marked hub exists', () => {
  for (const hub of HUBS) assert.ok(HUB_HINT[hub], `${hub} has no hint`)
  for (const hub of HUBS_WITHOUT_SCREENS) assert.ok(HUBS.includes(hub), `${hub} is not a hub`)
})
