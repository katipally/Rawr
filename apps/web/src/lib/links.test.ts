import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportCsvPath, exportPath, fromHubspotPath, objectView, recordPath, accountInPath, safeFrom, safePath } from './links.ts'

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
    page: '3',
    q: 'acme',
  })
  const query = new URL(url, 'https://rawr.test').searchParams
  assert.equal(query.get('cols'), 'first_name,email')
  assert.equal(query.get('limit'), '100')
  assert.equal(query.get('page'), '3')
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
    recordPath('datasaur', 'deal', 'abc', { tab: 'activities', interaction: 'call' }),
    '/contacts/datasaur/record/deal/abc?tab=activities&interaction=call',
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

test('a HubSpot object id opens the same screen under its readable key', () => {
  assert.equal(fromHubspotPath('/contacts/datasaur/record/0-1/abc'), '/contacts/datasaur/record/contact/abc')
  assert.equal(fromHubspotPath('/contacts/datasaur/objects/0-2/views/all/list'), '/contacts/datasaur/objects/company/views/all/list')
  assert.equal(fromHubspotPath('/contacts/datasaur/objects/0-3'), '/contacts/datasaur/objects/deal')
})

test('a HubSpot tasks link opens the tasks list, whichever view it named', () => {
  assert.equal(fromHubspotPath('/contacts/datasaur/objects/0-27/views/all/list'), '/contacts/datasaur/tasks')
  assert.equal(fromHubspotPath('/contacts/datasaur/objects/0-27/views/81234/list'), '/contacts/datasaur/tasks')
  assert.equal(fromHubspotPath('/contacts/datasaur/objects/0-27'), '/contacts/datasaur/tasks')
  assert.equal(fromHubspotPath('/contacts/datasaur/objects/0-270'), null)
})

test('a HubSpot segment, form or marketing email link opens the screen that holds it', () => {
  assert.equal(fromHubspotPath('/contacts/datasaur/objectLists/views/all'), '/contacts/datasaur/segments')
  assert.equal(fromHubspotPath('/contacts/datasaur/objectLists'), '/contacts/datasaur/segments')
  assert.equal(fromHubspotPath('/contacts/datasaur/objectLists/1561/filters'), '/contacts/datasaur/segments/1561')
  assert.equal(fromHubspotPath('/contacts/datasaur/objectLists/1561'), '/contacts/datasaur/segments/1561')
  assert.equal(fromHubspotPath('/contacts/datasaur/objectLists/create'), '/contacts/datasaur/segments?segment=new')
  assert.equal(fromHubspotPath('/forms/datasaur'), '/contacts/datasaur/forms')
  assert.equal(fromHubspotPath('/forms/datasaur/views/all_forms'), '/contacts/datasaur/forms')
  assert.equal(fromHubspotPath('/forms/datasaur/editor/af8f/edit/form'), '/contacts/datasaur/forms/af8f')
  assert.equal(fromHubspotPath('/forms/datasaur/new-editor/af8f'), '/contacts/datasaur/forms/af8f')
  assert.equal(fromHubspotPath('/submissions/datasaur/form/af8f/performance'), '/contacts/datasaur/forms/af8f/performance')
  assert.equal(fromHubspotPath('/submissions/datasaur/form/af8f/submissions'), '/contacts/datasaur/submissions?form=af8f&state=clean')
  assert.equal(fromHubspotPath('/submissions/datasaur/form/af8f/spam'), '/contacts/datasaur/submissions?form=af8f&state=confirmed_spam')
  assert.equal(fromHubspotPath('/email/datasaur/manage/state/all'), '/contacts/datasaur/newsletter')
  assert.equal(fromHubspotPath('/contacts/datasaur/segments/abc'), null)
})

test('a HubSpot sequence or template link opens the screen that holds it', () => {
  assert.equal(fromHubspotPath('/sequences/datasaur'), '/contacts/datasaur/sequences')
  assert.equal(fromHubspotPath('/sequences/datasaur/manage'), '/contacts/datasaur/sequences')
  assert.equal(fromHubspotPath('/sequences/datasaur/sequence/91'), '/contacts/datasaur/sequences/91')
  assert.equal(fromHubspotPath('/sequences/datasaur/sequence/91/edit'), '/contacts/datasaur/sequences/91')
  assert.equal(fromHubspotPath('/sequences/datasaur/sequence/91/performance'), '/contacts/datasaur/sequences/91')
  assert.equal(fromHubspotPath('/sequences/datasaur/sequence/91/settings'), '/contacts/datasaur/sequences/91?settings=open')
  assert.equal(fromHubspotPath('/sequences/datasaur/sequence/91/enrollments'), '/contacts/datasaur/sequences/91/enrollments')
  assert.equal(fromHubspotPath('/templates/datasaur'), '/contacts/datasaur/templates')
  assert.equal(fromHubspotPath('/templates/datasaur/new'), '/contacts/datasaur/templates?template=new')
  assert.equal(fromHubspotPath('/templates/datasaur/edit/50694446'), '/contacts/datasaur/templates?template=50694446')
  assert.equal(fromHubspotPath('/contacts/datasaur/sequences/91'), null)
})

test('a HubSpot scheduling page, booked meetings or calendar link opens the screen that holds it', () => {
  assert.equal(fromHubspotPath('/meetings/datasaur/link/new'), '/meetings/datasaur/pages?new=1')
  assert.equal(fromHubspotPath('/meetings/datasaur/link/13172537'), '/meetings/datasaur/pages/13172537')
  assert.equal(fromHubspotPath('/contacts/datasaur/objects/0-47/views/all/list'), '/meetings/datasaur/booked')
  assert.equal(fromHubspotPath('/contacts/datasaur/objects/0-47'), '/meetings/datasaur/booked')
  assert.equal(fromHubspotPath('/settings/datasaur/user-preferences/calendar'), '/meetings/datasaur/calendars')
  assert.equal(fromHubspotPath('/meetings/datasaur/pages'), null)
  assert.equal(fromHubspotPath('/settings/mailboxes'), null)
})

test('a HubSpot dashboard or reports link opens the screen that holds it', () => {
  assert.equal(fromHubspotPath('/reports-dashboard/datasaur/view/13647808'), '/contacts/datasaur/reports/dashboards/13647808')
  assert.equal(fromHubspotPath('/reports-dashboard/datasaur/view'), '/contacts/datasaur/reports/dashboards')
  assert.equal(fromHubspotPath('/reports-dashboard/datasaur'), '/contacts/datasaur/reports/dashboards')
  assert.equal(fromHubspotPath('/reports-list/datasaur/dashboards/views/-4'), '/contacts/datasaur/reports/dashboards')
  assert.equal(fromHubspotPath('/reports-list/datasaur'), '/contacts/datasaur/reports/list')
  assert.equal(fromHubspotPath('/reports-list/datasaur/views/-1'), '/contacts/datasaur/reports/list')
  assert.equal(fromHubspotPath('/reports-list/datasaur/340431119'), '/contacts/datasaur/reports/list')
  assert.equal(fromHubspotPath('/contacts/datasaur/reports/dashboards'), null)
})

test('a HubSpot home link opens home', () => {
  assert.equal(fromHubspotPath('/user-home/datasaur'), '/contacts/datasaur/home')
  assert.equal(fromHubspotPath('/user-home/datasaur/'), '/contacts/datasaur/home')
  assert.equal(fromHubspotPath('/user-home'), null)
})

test('a HubSpot import, duplicates, restore or connected apps link opens the screen that holds it', () => {
  assert.equal(fromHubspotPath('/import/datasaur'), '/contacts/datasaur/import')
  assert.equal(fromHubspotPath('/data-integration-home/datasaur/post/73801025'), '/contacts/datasaur/import')
  assert.equal(fromHubspotPath('/data-integration-home/datasaur/new-import/standard'), '/contacts/datasaur/import/new')
  assert.equal(fromHubspotPath('/duplicates/datasaur'), '/contacts/datasaur/duplicates')
  assert.equal(fromHubspotPath('/duplicates/datasaur/contacts'), '/contacts/datasaur/duplicates')
  assert.equal(fromHubspotPath('/duplicates/datasaur/companies'), '/contacts/datasaur/duplicates?object=company')
  assert.equal(fromHubspotPath('/contacts/datasaur/objects/0-1/restore'), '/contacts/datasaur/restore')
  assert.equal(fromHubspotPath('/contacts/datasaur/objects/0-3/restore'), '/contacts/datasaur/restore?object=deal')
  assert.equal(fromHubspotPath('/connected-apps/datasaur/installed'), '/apps')
  assert.equal(fromHubspotPath('/connected-apps/datasaur/installed/basic/51323/overview'), '/apps')
  assert.equal(fromHubspotPath('/integrations-settings/datasaur/installed'), '/apps')
  assert.equal(fromHubspotPath('/marketplace/datasaur/apps'), '/apps/available')
  assert.equal(fromHubspotPath('/ecosystem/datasaur/marketplace/apps'), '/apps/available')
})

test('a HubSpot users, teams, defaults, preferences, audit log or service key link opens its settings page', () => {
  assert.equal(fromHubspotPath('/settings/datasaur/users'), '/settings/members')
  assert.equal(fromHubspotPath('/settings/datasaur/users/active_users'), '/settings/members')
  assert.equal(fromHubspotPath('/settings/datasaur/users/user/49756527'), '/settings/members')
  assert.equal(fromHubspotPath('/settings/datasaur/users/teams'), '/settings/teams')
  assert.equal(fromHubspotPath('/settings/datasaur/account-defaults/general'), '/settings/defaults')
  assert.equal(fromHubspotPath('/settings/datasaur/account-defaults/currency'), '/settings/defaults?tab=currency')
  assert.equal(fromHubspotPath('/settings/datasaur/user-preferences/general'), '/settings/account')
  assert.equal(fromHubspotPath('/settings/datasaur/user-preferences/profile'), '/settings/account')
  assert.equal(fromHubspotPath('/settings/datasaur/user-preferences/security'), '/settings/account?tab=security')
  assert.equal(fromHubspotPath('/settings/datasaur/user-preferences/calendar'), '/meetings/datasaur/calendars')
  assert.equal(fromHubspotPath('/account-and-billing/datasaur/audit-logs'), '/settings/audit')
  assert.equal(fromHubspotPath('/service-keys/datasaur'), '/settings/agent')
  assert.equal(fromHubspotPath('/private-apps/datasaur'), '/settings/agent')
  assert.equal(fromHubspotPath('/settings/members'), null)
  assert.equal(fromHubspotPath('/settings/tracking/events'), null)
})

test('a path with no HubSpot object id is left alone', () => {
  assert.equal(fromHubspotPath('/contacts/datasaur/record/contact/abc'), null)
  assert.equal(fromHubspotPath('/contacts/datasaur/record/0-14/abc'), null)
  assert.equal(fromHubspotPath('/contacts/0-1/home'), null)
})
