import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { AUDIT_TARGETS } from '@rawr/db/audit-targets'
import { actionOf, categoryOf, fieldOf } from './audit-labels.ts'

/** Every action literal the DAL and the server write into the audit log, read from
 *  the source the way packages/db/src/dal/audit.test.ts reads entities. Covers the
 *  plain `action: 'x'` and the ternaries that pick between two. `z.` is the zod
 *  schema for a bulk action's `type`, not an audit row. */
const writtenActions = (): Set<string> => {
  const found = new Set<string>()
  const roots = [new URL('../../../../packages/db/src/dal/', import.meta.url), new URL('../server/', import.meta.url)]
  for (const root of roots) {
    for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const source = readFileSync(new URL(file, root), 'utf8')
      for (const line of source.matchAll(/action: (?!z\.)([^\n]+)/g)) {
        for (const literal of line[1]!.matchAll(/(?<!=== )'([a-z_-]+)'/g)) found.add(literal[1]!)
      }
    }
  }
  return found
}

/** Activity kinds a person logs by hand or through the MCP tool. The DAL writes them
 *  as `action: input.type`, which the literal scan cannot see. */
const LOGGED_KINDS = ['note', 'call', 'meeting', 'email', 'task']

/** Whole actions, written out because the verb rule cannot read them. */
const WHOLE: Record<string, string> = {
  note: 'Added a note',
  call: 'Logged a call',
  email: 'Logged an email',
  meeting: 'Logged a meeting',
  task: 'Added a task',
  'conference-link': 'Added a conference link',
  send_failed: 'Failed to send',
  replay_failed: 'Failed to replay',
  read: 'Marked read',
  unread: 'Marked unread',
  status: 'Changed the status',
  set_members: 'Changed the members',
}

/** Verbs whose past tense the rule gets wrong, with the past they take. */
const IRREGULAR: Record<string, string> = { send: 'sent', resend: 'resent', set: 'set', submit: 'submitted' }

/** Verbs checked by hand to take the rule's past tense: "-ed", "-ied", a doubled
 *  final consonant, or a final "e" dropped before "d". A new verb fails the test
 *  until it is added here, or to WHOLE or IRREGULAR with its phrase. */
const REGULAR = new Set([
  'accept', 'add', 'approve', 'archive', 'assign', 'associate', 'cancel', 'clear', 'clone', 'confirm',
  'connect', 'copy', 'create', 'deactivate', 'delete', 'disable', 'discard', 'disconnect', 'dissociate',
  'duplicate', 'edit', 'enable', 'enrich', 'enroll', 'erase', 'export', 'invite', 'map', 'merge', 'move',
  'promote', 'publish', 'purge', 'reactivate', 'release', 'remove', 'rename', 'reorder', 'replay',
  'reschedule', 'restore', 'resume', 'retry', 'revoke', 'roll', 'save', 'store', 'trash', 'unarchive',
  'unassign', 'unpublish', 'update', 'wait',
])

test('every action the DAL and server write renders from the table or a verb checked as regular', () => {
  const unknown: string[] = []
  for (const action of [...writtenActions(), ...LOGGED_KINDS]) {
    const [verb = '', ...rest] = action.split('_')
    if (action in WHOLE) {
      assert.equal(actionOf(action), WHOLE[action], action)
    } else if (verb in IRREGULAR) {
      assert.equal(actionOf(action), [IRREGULAR[verb], ...rest].join(' ').replace(/^./, (c) => c.toUpperCase()), action)
    } else if (!REGULAR.has(verb)) {
      unknown.push(action)
    }
  }
  assert.deepEqual(unknown, [], 'add each to WHOLE, IRREGULAR or REGULAR once its past tense is checked')
})

test('past tense follows the verb, not only the common endings', () => {
  assert.equal(actionOf('copy_grants'), 'Copied grants')
  assert.equal(actionOf('carry_over'), 'Carried over')
  assert.equal(actionOf('delay_send'), 'Delayed send')
  assert.equal(actionOf('send_message'), 'Sent message')
  assert.equal(actionOf('set_grants'), 'Set grants')
  assert.equal(actionOf('save_steps'), 'Saved steps')
  assert.equal(actionOf('enroll'), 'Enrolled')
  assert.equal(actionOf('roll_secret'), 'Rolled secret')
  assert.equal(actionOf('retry_index'), 'Retried index')
  assert.equal(actionOf('wait_for_task'), 'Waited for task')
  assert.equal(actionOf('store_body'), 'Stored body')
})

test('an action whose first word is not its verb reads as a whole phrase', () => {
  assert.equal(actionOf('send_failed'), 'Failed to send')
  assert.equal(actionOf('call'), 'Logged a call')
  assert.equal(actionOf('booking'), 'Booked')
  assert.equal(actionOf('stage_change'), 'Changed the stage')
  assert.equal(actionOf('conference-link'), 'Added a conference link')
})

test('read state actions say what happened to the read flag', () => {
  assert.equal(actionOf('read'), 'Marked read')
  assert.equal(actionOf('unread'), 'Marked unread')
  assert.equal(actionOf('set_members'), 'Changed the members')
  assert.equal(actionOf('status'), 'Changed the status')
})

test('every audited entity has a category name that reads as a sentence', () => {
  for (const entity of Object.keys(AUDIT_TARGETS)) {
    assert.match(categoryOf(entity), /^[A-Z][A-Za-z ]*$/, entity)
  }
})

test('category names read as words, with the terms the app spells in capitals', () => {
  assert.equal(categoryOf('mcp_token'), 'MCP token')
  assert.equal(categoryOf('field_def'), 'Field definition')
  assert.equal(categoryOf('import_run'), 'Import run')
  assert.equal(categoryOf('contact'), 'Contact')
  assert.equal(categoryOf('oauth_grant'), 'OAuth grant')
  assert.equal(categoryOf('message_thread_read'), 'Read state')
})

test('changed field keys read as words', () => {
  assert.equal(fieldOf('reassignedTo'), 'reassigned to')
  assert.equal(fieldOf('first_name'), 'first name')
  assert.equal(fieldOf('state'), 'state')
})
