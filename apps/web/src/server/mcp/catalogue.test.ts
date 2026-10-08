import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TOOLS, TOOLS_BY_NAME, toolsetOf } from './catalogue.ts'
import { duplicateObject } from './tools.ts'
import { onConnection, parseToolsets } from './toolsets.ts'

/** [forward, reverse]. The reverse undoes the forward, so it has to be listed on
 *  every connection the forward is listed on. */
const REVERSES: [string, string][] = [
  ['crm_records_dismiss_duplicate', 'put_back_duplicate'],
  ['crm_records_remove', 'crm_records_restore'],
  ['crm_associations_add', 'crm_associations_remove'],
  ['admin_fields_remove', 'admin_fields_restore'],
  ['mail_blocklist_add', 'mail_blocklist_remove'],
  ['sequences_enrollments_pause', 'sequences_enrollments_resume'],
]

test('every tool name is listed once', () => {
  assert.equal(new Set(TOOLS.map((tool) => tool.name)).size, TOOLS.length)
})

test('every reverse is a listed tool with a description', () => {
  for (const [forward, reverse] of REVERSES) {
    for (const name of [forward, reverse]) {
      const tool = TOOLS_BY_NAME.get(name)
      assert.ok(tool, `${name} is not a tool`)
      assert.ok(tool.description({ registry: {} as never }).trim().length > 0, `${name} has no description`)
    }
  }
})

test('every reverse shares its forward tool toolset, so one switch turns both off', () => {
  for (const [forward, reverse] of REVERSES) {
    assert.equal(toolsetOf(TOOLS_BY_NAME.get(reverse)!), toolsetOf(TOOLS_BY_NAME.get(forward)!), `${reverse} vs ${forward}`)
  }
})

test('a reverse is listed on a connection whose toolsets include its forward', () => {
  for (const [forward, reverse] of REVERSES) {
    const enabled = parseToolsets(toolsetOf(TOOLS_BY_NAME.get(forward)!))
    assert.equal(onConnection(enabled, toolsetOf(TOOLS_BY_NAME.get(reverse)!)), true, reverse)
  }
})

test('put back is a write and the set-aside list is a read', () => {
  assert.equal(TOOLS_BY_NAME.get('put_back_duplicate')?.writes, true)
  assert.equal(TOOLS_BY_NAME.get('list_set_aside_duplicates')?.writes, false)
})

test('only contacts and companies have a duplicates queue', () => {
  assert.equal(duplicateObject('contact'), 'contact')
  assert.equal(duplicateObject('company'), 'company')
  for (const value of ['deal', '', undefined, null, 7]) assert.equal(duplicateObject(value), undefined, String(value))
})
