import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HUBS as DB_HUBS, SCOPES as DB_SCOPES } from '@rawr/db'
import { HUBS, HUB_HINT, HUBS_WITHOUT_SCREENS, HUBS_WITH_RECORDS, SCOPES, SCOPE_LABEL } from './hubs.ts'

/** The client copy of the hub list. If it drifts from the database's, a grant the
 *  grid offers is one the server has never heard of, or vice versa. */
test('the client hub list matches the data access layer', () => {
  assert.deepEqual([...HUBS], [...DB_HUBS])
})

test('every hub has a hint and every marked hub exists', () => {
  for (const hub of HUBS) assert.ok(HUB_HINT[hub], `${hub} has no hint`)
  for (const hub of HUBS_WITHOUT_SCREENS) assert.ok(HUBS.includes(hub), `${hub} is not a hub`)
})

test('the client scope list matches the data access layer', () => {
  assert.deepEqual([...SCOPES], [...DB_SCOPES])
})

test('every scope has a label and every record hub is a hub', () => {
  for (const scope of SCOPES) assert.ok(SCOPE_LABEL[scope], `${scope} has no label`)
  for (const hub of HUBS_WITH_RECORDS) assert.ok(HUBS.includes(hub), `${hub} is not a hub`)
})
