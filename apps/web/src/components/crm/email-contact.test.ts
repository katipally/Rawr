import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emailContactOf } from './email-contact.ts'

test('no contact group means no email target', () => {
  assert.equal(emailContactOf([{ objectKey: 'company', records: [{ id: 'c1', email: null }] }]), null)
})

test('contacts with no address are skipped', () => {
  const groups = [{ objectKey: 'contact', records: [{ id: 'a', email: null }, { id: 'b', email: '' }] }]
  assert.equal(emailContactOf(groups), null)
})

test('the first linked contact with an address is the target', () => {
  const groups = [
    { objectKey: 'company', records: [{ id: 'x', email: 'x@acme.test' }] },
    { objectKey: 'contact', records: [{ id: 'a', email: null }, { id: 'b', email: 'b@acme.test' }, { id: 'c', email: 'c@acme.test' }] },
  ]
  assert.deepEqual(emailContactOf(groups), { id: 'b', email: 'b@acme.test' })
})
