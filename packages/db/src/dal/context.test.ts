import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canWrite, systemContext } from './context.ts'
import { publicEdgeContext } from './forms.ts'

/** The two non-interactive contexts, and the line between them.
 *
 *  This exists because three shipped features were dead at once for one reason:
 *  work Rawr does on its own behalf was running with the public edge's grants, and
 *  every suite passed anyway because each called the data access layer directly
 *  with a context holding every hub. Nothing exercised the context the running
 *  code actually builds. These do.
 */

/** Everything written by a queued job, a token refresh, or a booking lifecycle
 *  step that runs after the person who started it has gone. */
const SYSTEM_WRITES = [
  'booking',
  'calendar_grant',
  'sequence_enrollment',
  'sequence',
  'contact',
  'company',
  'deal',
  'activity',
  'task',
  'dead_letter',
  'integration',
  'mailbox',
  'message_thread_read',
  'form_submission',
  'notification',
]

test('the system context can write everything the jobs and lifecycle steps touch', () => {
  const ctx = systemContext('11111111-1111-1111-1111-111111111111')
  for (const entity of SYSTEM_WRITES) {
    assert.equal(canWrite(ctx, entity), true, `a job cannot write ${entity}`)
  }
})

test('the system context is still below the super admin line', () => {
  assert.equal(systemContext('11111111-1111-1111-1111-111111111111').isSuperAdmin, false)
})

test('the system context is a job in the audit log, never a person or a stranger', () => {
  const ctx = systemContext('11111111-1111-1111-1111-111111111111')
  assert.equal(ctx.actorKind, 'job')
  assert.equal(ctx.actorId, null)
})

/** A stranger on the internet writes what a form capture needs and nothing else.
 *  Widening this to unblock a job is the mistake that produced the bug above. */
test('the public edge stays narrow', () => {
  const ctx = publicEdgeContext('11111111-1111-1111-1111-111111111111')
  assert.equal(canWrite(ctx, 'contact'), true)
  assert.equal(canWrite(ctx, 'form_submission'), true)
  for (const entity of ['calendar_grant', 'sequence_enrollment', 'sequence', 'deal', 'field_def', 'membership']) {
    assert.equal(canWrite(ctx, entity), false, `the public edge can write ${entity}`)
  }
})
