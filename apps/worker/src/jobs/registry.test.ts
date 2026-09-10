import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { accountIdOf, bySlug, defineJob } from './registry.ts'

/** What the runner does before it runs anything: refuse a payload that can never
 *  succeed, and name the field that was wrong, because a dead letter reading
 *  "Payload rejected" and nothing else is a dead end. */

const job = defineJob({
  name: 'test.job',
  schema: z.object({ accountId: z.uuid(), mailboxId: z.uuid() }),
  retryLimit: 1,
  retryDelaySeconds: 1,
  handle: async () => {},
})

const account = '7f5f2c58-2e0e-4f0e-9a4a-6a3b2f5a1c11'

test('a payload that matches goes through', () => {
  const parsed = job.parse({ accountId: account, mailboxId: account })
  assert.equal(parsed.ok, true)
})

test('a missing field is refused by name', () => {
  const parsed = job.parse({ accountId: account })
  assert.equal(parsed.ok, false)
  assert.match(parsed.ok === false ? parsed.error : '', /mailboxId/)
})

test('something that is not a uuid is refused by name', () => {
  const parsed = job.parse({ accountId: 'not-a-uuid', mailboxId: account })
  assert.equal(parsed.ok, false)
  assert.match(parsed.ok === false ? parsed.error : '', /accountId/)
})

test('a payload that is not an object at all is refused rather than thrown on', () => {
  assert.equal(job.parse(null).ok, false)
  assert.equal(job.parse('mailbox').ok, false)
})

test('the account is read off a rejected payload, so the dead letter can be scoped', () => {
  assert.equal(accountIdOf({ accountId: account }), account)
  assert.equal(accountIdOf({ accountId: 12 }), null)
  assert.equal(accountIdOf(null), null)
})

test('a cross-tenant sweep is counted by slug', () => {
  assert.equal(bySlug([{ slug: 'datasaur' }, { slug: 'sandbox' }, { slug: 'datasaur' }]), 'datasaur 2, sandbox 1')
  assert.equal(bySlug([]), '')
})
