import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workspaceInPath } from './links.ts'

/** Read by the proxy on every CRM navigation and by the Google callback when it
 *  chooses which workspace to land in, so a wrong answer here is either a
 *  redirect loop or somebody dropped into the wrong tenant's screen. */

test('both scoped families put the slug in the same place', () => {
  assert.equal(workspaceInPath('/contacts/datasaur/home'), 'datasaur')
  assert.equal(workspaceInPath('/meetings/datasaur/pages'), 'datasaur')
  assert.equal(workspaceInPath('/contacts/probe/record/contact/abc'), 'probe')
})

test('the slug stops at the next separator, whichever it is', () => {
  assert.equal(workspaceInPath('/contacts/datasaur'), 'datasaur')
  assert.equal(workspaceInPath('/contacts/datasaur/'), 'datasaur')
  assert.equal(workspaceInPath('/contacts/datasaur?tab=activity'), 'datasaur')
  assert.equal(workspaceInPath('/contacts/datasaur#top'), 'datasaur')
})

test('an escaped slug is decoded, because that is what the switch handler compares', () => {
  assert.equal(workspaceInPath('/contacts/two%20words/home'), 'two words')
})

test('a half-escaped slug is no slug rather than a guess', () => {
  assert.equal(workspaceInPath('/contacts/%E0%A4%A/home'), null)
})

test('paths outside the two families name no workspace', () => {
  for (const path of [
    '/settings/properties',
    '/sign-in',
    '/api/auth/workspace',
    '/form/datasaur/contact-us',
    '/b/datasaur/intro',
    '/contacts',
    '/contacts/',
    '/',
    '',
    null,
    undefined,
  ]) {
    assert.equal(workspaceInPath(path), null, String(path))
  }
})

test('the pattern is anchored, so a workspace cannot be smuggled in later', () => {
  assert.equal(workspaceInPath('/settings/contacts/probe/home'), null)
  assert.equal(workspaceInPath('https://evil.example/contacts/probe/home'), null)
})
