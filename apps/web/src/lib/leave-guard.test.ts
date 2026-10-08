import assert from 'node:assert/strict'
import { test } from 'node:test'
import { leavesPage } from './leave-guard.ts'

const here = new URL('https://rawr.best/contacts/acme/forms/abc?tab=form')

test('another path of the app leaves the page', () => {
  assert.equal(leavesPage('/meetings/acme', here), true)
  assert.equal(leavesPage('https://rawr.best/meetings/acme', here), true)
})

test('a different query on the same path leaves the page', () => {
  assert.equal(leavesPage('/contacts/acme/forms/abc?tab=settings', here), true)
})

test('the same path and query, or only a hash, stays on the page', () => {
  assert.equal(leavesPage('/contacts/acme/forms/abc?tab=form', here), false)
  assert.equal(leavesPage('#fields', here), false)
})

test('another origin leaves the page', () => {
  assert.equal(leavesPage('https://example.com/', here), true)
})
