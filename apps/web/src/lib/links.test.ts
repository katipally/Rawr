import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportCsvPath, exportPath, objectView, recordPath, accountInPath } from './links.ts'

/** Read by the proxy on every CRM navigation and by the Google callback when it
 *  chooses which account to land in, so a wrong answer here is either a
 *  redirect loop or somebody dropped into the wrong tenant's screen. */

test('both scoped families put the slug in the same place', () => {
  assert.equal(accountInPath('/contacts/datasaur/home'), 'datasaur')
  assert.equal(accountInPath('/meetings/datasaur/pages'), 'datasaur')
  assert.equal(accountInPath('/contacts/probe/record/contact/abc'), 'probe')
})

test('the slug stops at the next separator, whichever it is', () => {
  assert.equal(accountInPath('/contacts/datasaur'), 'datasaur')
  assert.equal(accountInPath('/contacts/datasaur/'), 'datasaur')
  assert.equal(accountInPath('/contacts/datasaur?tab=activity'), 'datasaur')
  assert.equal(accountInPath('/contacts/datasaur#top'), 'datasaur')
})

test('an escaped slug is decoded, because that is what the switch handler compares', () => {
  assert.equal(accountInPath('/contacts/two%20words/home'), 'two words')
})

test('a half-escaped slug is no slug rather than a guess', () => {
  assert.equal(accountInPath('/contacts/%E0%A4%A/home'), null)
})

test('paths outside the two families name no account', () => {
  for (const path of [
    '/settings/properties',
    '/sign-in',
    '/api/auth/account',
    '/form/datasaur/contact-us',
    '/b/datasaur/intro',
    '/contacts',
    '/contacts/',
    '/',
    '',
    null,
    undefined,
  ]) {
    assert.equal(accountInPath(path), null, String(path))
  }
})

test('the pattern is anchored, so a account cannot be smuggled in later', () => {
  assert.equal(accountInPath('/settings/contacts/probe/home'), null)
  assert.equal(accountInPath('https://evil.example/contacts/probe/home'), null)
})

/** B8. What the toolbar and the pager put in the address. Both are read back on
 *  the server, so a builder that dropped one would silently ignore a column set
 *  or a page size somebody chose. */

test('a chosen column set and page size survive the round trip', () => {
  const url = objectView('datasaur', 'contact', 'all', 'list', {
    cols: 'first_name,email',
    limit: '100',
    skip: '100',
    q: 'acme',
  })
  const query = new URL(url, 'https://rawr.test').searchParams
  assert.equal(query.get('cols'), 'first_name,email')
  assert.equal(query.get('limit'), '100')
  assert.equal(query.get('skip'), '100')
  assert.equal(query.get('q'), 'acme')
})

test('an empty or absent parameter is left out rather than written blank', () => {
  const url = objectView('datasaur', 'contact', 'all', 'list', {
    cols: '',
    limit: undefined,
    q: 'acme',
  })
  assert.equal(url, '/contacts/datasaur/objects/contact/views/all/list?q=acme')
})

test('the export page and the file it hands over are different addresses', () => {
  assert.equal(exportPath('datasaur'), '/contacts/datasaur/export')
  assert.equal(
    exportCsvPath('datasaur', { object: 'contact', columns: 'email' }),
    '/contacts/datasaur/export/csv?object=contact&columns=email',
  )
})

test('a record quick action is a link, so it can be sent to somebody', () => {
  assert.equal(
    recordPath('datasaur', 'deal', 'abc', { tab: 'activities', log: 'call' }),
    '/contacts/datasaur/record/deal/abc?tab=activities&log=call',
  )
})
