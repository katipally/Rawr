import assert from 'node:assert/strict'
import { test } from 'node:test'
import { archiveUsageCopy, purgeResultCopy } from './field-usage-copy.ts'

test('the archive message agrees with one record and with many', () => {
  assert.equal(archiveUsageCopy(1, '1'), '1 record holds a value, and that value stays exactly where it is.')
  assert.equal(archiveUsageCopy(1200, '1,200'), '1,200 records hold a value, and every one of those values stays exactly where it is.')
})

test('the archive message keeps its own sentence for none', () => {
  assert.equal(archiveUsageCopy(0, '0'), 'No record holds a value for it.')
})

test('the purge message agrees with one record, many and none', () => {
  assert.equal(purgeResultCopy(1, '1'), '1 record had the value stripped.')
  assert.equal(purgeResultCopy(3, '3'), '3 records had the value stripped.')
  assert.equal(purgeResultCopy(0, '0'), '0 records had the value stripped.')
})
