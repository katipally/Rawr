import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deletedDealsRefusal, liveDealsRefusal } from './pipelines.ts'

test('a pipeline refusing over live deals agrees with one deal and with many', () => {
  assert.equal(
    liveDealsRefusal('Sales', 1),
    'Sales still holds 1 deal. Move it to another pipeline first; deleting would leave it with no stage.',
  )
  assert.equal(
    liveDealsRefusal('Sales', 3),
    'Sales still holds 3 deals. Move them to another pipeline first; deleting would leave them with no stage.',
  )
})

test('a refusal over deleted deals agrees with one deal and with many', () => {
  assert.equal(
    deletedDealsRefusal('Sales', 1, 'another stage to move to. Add one to this pipeline first.'),
    'Sales still holds 1 deleted deal that needs another stage to move to. Add one to this pipeline first.',
  )
  assert.equal(
    deletedDealsRefusal('Sales', 12, 'a stage to move to. Add a stage to Renewals first.'),
    'Sales still holds 12 deleted deals that need a stage to move to. Add a stage to Renewals first.',
  )
})
