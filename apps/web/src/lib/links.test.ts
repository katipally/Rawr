import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportCsvPath, exportPath, objectView, recordPath, accountInPath, safeFrom, safePath } from './links.ts'

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

test('the pattern is anchored, so an account cannot be smuggled in later', () => {
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

/** Back on a record follows `from`, which anyone can write into a link, so every
 *  form of "somewhere else" has to come out as no origin at all. */
test('a list on this account is a valid origin, filters and all', () => {
  const list = '/contacts/datasaur/objects/contact/views/all/list?filters=%5B%5D&sort=-created_at'
  assert.equal(safeFrom(list, 'datasaur'), list)
  assert.equal(safeFrom('/contacts/datasaur/record/deal/abc?tab=activities', 'datasaur'), '/contacts/datasaur/record/deal/abc?tab=activities')
})

test('an origin on another account is refused', () => {
  assert.equal(safeFrom('/contacts/probe/objects/contact/views/all/list', 'datasaur'), null)
})

test('anything the browser would read as another host is refused', () => {
  for (const hostile of ['//evil.com', '/\\evil.com', '\\\\evil.com', 'https://evil.com', 'http://evil.com/contacts/datasaur/home', 'javascript:alert(1)', '/\t/evil.com', '/\n/evil.com']) {
    assert.equal(safeFrom(hostile, 'datasaur'), null, hostile)
  }
})

test('a relative form that names no account is refused', () => {
  for (const value of ['', null, undefined, 'contacts/datasaur/home', '/', '/settings/members', '/contacts']) {
    assert.equal(safeFrom(value, 'datasaur'), null, String(value))
  }
})

test('an origin too long to be a real address is refused', () => {
  assert.equal(safeFrom(`/contacts/datasaur/home?x=${'a'.repeat(3000)}`, 'datasaur'), null)
})

test('the origin travels in the record address and comes back out of it', () => {
  const list = '/contacts/datasaur/objects/deal/views/all/list?sort=-amount'
  const href = recordPath('datasaur', 'deal', 'abc', { from: list })
  assert.equal(safeFrom(new URL(href, 'http://x').searchParams.get('from'), 'datasaur'), list)
})

/** Every redirect that follows an address, a cookie or a form field ends in
 *  safePath, so the parser's reading of a value is what decides where it goes. */
test('a path on this site comes back as written, query string and hash included', () => {
  for (const ok of ['/', '/contacts/datasaur/home', '/oauth/authorize?client_id=x&state=y', '/settings/mailboxes?error=a%20b#top', '/%5Cevil.com']) {
    assert.equal(safePath(ok), ok)
  }
})

test('anything the browser would read as another host falls back', () => {
  for (const hostile of ['/\\evil.com', '//evil.com', '///evil.com', '\\\\evil.com', 'https://evil.com', '//\\evil.com', 'javascript:alert(1)', '/\t/evil.com', '/\n/evil.com', '/\r/evil.com', '/\t\\evil.com', '\t//evil.com', 'evil.com', '', null, undefined]) {
    assert.equal(safePath(hostile), '/', JSON.stringify(hostile))
    assert.equal(safePath(hostile, '/settings/mailboxes'), '/settings/mailboxes', JSON.stringify(hostile))
  }
})

test('a path is handed back in the parser\'s form, so dot segments are resolved', () => {
  assert.equal(safePath('/contacts/../settings?x=1'), '/settings?x=1')
})
