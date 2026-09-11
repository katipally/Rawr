import { sql } from 'drizzle-orm'
import { appDb, closeAppPool } from '../src/internal/pool.ts'
import {
  aliasFromPublicEdge,
  backfillVisitor,
  collect,
  createSite,
  eraseContactActivity,
  EVENT_NAME_CAP,
  eventCountsByDay,
  eventFunnel,
  exportContactActivity,
  isBot,
  isVisitorId,
  listCollectorNotices,
  listEventDefs,
  listSites,
  mergeRecords,
  OVERFLOW_EVENT,
  piiViolations,
  publicSite,
  readPageView,
  readTimeline,
  refreshContactActivity,
  rollUpExpired,
  saveEventDef,
  setSiteActive,
  timelineCounts,
  websiteActivity,
  withAccount,
  type AccountContext,
} from '../src/index.ts'
import { PEER, SANDBOX, seatFor, cleanup } from './fixture.ts'

/** F4's definition of done, run against the real database, exiting non-zero on
 *  failure so it can gate a build. Same shape as verify-forms.ts. */

let failures = 0
let checks = 0

const pass = (what: string, detail?: string) => {
  checks++
  console.log(`PASS  ${what}${detail ? `  ${detail}` : ''}`)
}

const fail = (what: string, detail: string) => {
  checks++
  failures++
  console.log(`FAIL  ${what}\n      ${detail}`)
}

const check = (what: string, condition: boolean, detail?: string) => {
  if (condition) pass(what, detail)
  else fail(what, detail ?? 'condition was false')
}

const section = (title: string) =>
  console.log(`\n-- ${title} ${'-'.repeat(Math.max(0, 60 - title.length))}`)

const ctxFor = async (slug: string, editHubs: string[] = ['contacts', 'sales', 'marketing', 'service', 'reports', 'account']): Promise<AccountContext> => {
  const rows = await appDb.execute<{ id: string }>(
    sql`select id from rawr.account_for_site(${slug})`,
  )
  const id = rows[0]?.id
  if (!id) throw new Error(`account ${slug} is not seeded. Run pnpm db:seed.`)
  // Seated on a real member, because this context writes: it creates sites and
  // erases visitors, and every one of those lands in audit_log. Claiming to be a
  // person and naming nobody left rows that verify-account rightly refuses —
  // which it only noticed on the run after this suite, since the two share a
  // database and account goes first.
  // Seated on a real member, because this context writes and every write names
  // its actor in audit_log.
  return { accountId: id, actorId: await seatFor(id, slug), actorKind: 'user', isSuperAdmin: false, viewHubs: [], editHubs: editHubs as AccountContext['editHubs'] }
}

const scoped = <T extends Record<string, unknown>>(
  ctx: AccountContext,
  query: ReturnType<typeof sql>,
): Promise<T[]> => withAccount(ctx, (tx) => tx.execute<T>(query) as Promise<T[]>)

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'

/** Unique per run so a re-run does not read the previous one's rows. */
const stamp = process.hrtime.bigint().toString(36)
const vid = (label: string): string => `v${stamp}${label}`.padEnd(20, '0').slice(0, 60)

const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000)

const newContact = async (ctx: AccountContext, email: string): Promise<string> => {
  const rows = await scoped<{ id: string }>(
    ctx,
    sql`insert into contact (account_id, first_name, last_name, email)
        values (${ctx.accountId}, 'Activity', ${email}, ${`${email}@example.com`})
        returning id`,
  )
  const id = rows[0]?.id
  if (!id) throw new Error('the harness could not create a contact')
  return id
}

try {
  const datasaur = await ctxFor(SANDBOX.slug)
  const probe = await ctxFor(PEER.slug)

  // -------------------------------------------------------------------------
  section('sites')

  const site = await publicSite('sandbox-www')
  check('the seeded site key resolves an account', site?.accountId === datasaur.accountId)
  check('an unknown site key resolves nothing', (await publicSite('no-such-site')) === null)
  check(
    'and a key long enough to be an attack is refused before it reaches the database',
    (await publicSite('x'.repeat(200))) === null,
  )
  if (!site) throw new Error('the seeded site is missing. Run pnpm db:seed.')

  const created = await createSite(datasaur, {
    name: `Probe app ${stamp}`,
    host: 'app.datasaur.ai',
    siteKey: `app-${stamp}`,
  })
  check('two sites can share one account', created.id.length === 36, 'undecided either way')

  check(
    'a site key already held by another tenant is refused with a real message',
    await refusesAsyncWith(
      () => createSite(probe, { name: 'Collision', host: PEER.domain, siteKey: 'sandbox-www' }),
      'already in use',
    ),
    'the unique index is the test, not a check-then-insert row level security hides',
  )
  check(
    'a site key with spaces is refused',
    await refusesAsync(() =>
      createSite(datasaur, { name: 'Bad', host: 'datasaur.ai', siteKey: 'not a key' }),
    ),
  )
  check(
    'a host that is not a host is refused',
    await refusesAsync(() =>
      createSite(datasaur, { name: 'Bad', host: 'localhost', siteKey: `h-${stamp}` }),
    ),
  )

  await setSiteActive(datasaur, created.id, false)
  check(
    'turning a site off actually stops collection',
    (await publicSite(`app-${stamp}`)) === null,
    'the resolver refuses it, so the collector never gets an account',
  )
  await setSiteActive(datasaur, created.id, true)

  const sites = await listSites(datasaur)
  check('the admin list shows this account only', sites.every((row) => row.siteKey !== 'peer-www'))

  // -------------------------------------------------------------------------
  section('what the collector refuses')

  check('a real Chrome user agent is not a bot', !isBot(CHROME))
  for (const crawler of [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0 Safari/537.36',
    'curl/8.7.1',
    'python-requests/2.32.0',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  ]) {
    check(`${crawler.slice(0, 40)}… is scored as a bot`, isBot(crawler))
  }
  check('no user agent at all is not a browser', isBot(null))

  check('a uuid is a usable visitor id', isVisitorId('0b2b8f1e-6a3d-4a6b-9a9d-9f2a1c0d5e77'))
  check('a visitor id from a query parameter shape is refused', !isVisitorId('../../etc/passwd'))
  check('and one too short to be random is refused', !isVisitorId('abc'))

  check(
    'an email in a property is caught',
    piiViolations({ plan: 'pro', who: 'someone@sandbox.test' }).includes('who'),
  )
  check('a phone number is caught', piiViolations({ contact: '+1 415 555 0134' }).includes('contact'))
  check('a property named email is caught whatever it holds', piiViolations({ email: 'x' }).length === 1)
  check('and an ordinary property is left alone', piiViolations({ plan: 'pro', seats: 4 }).length === 0)

  // -------------------------------------------------------------------------
  section('collecting')

  const anon = vid('anon')
  const first = await collect({
    site,
    visitorId: anon,
    at: minutesAgo(120),
    url: 'https://datasaur.ai/products/data-studio?utm_source=newsletter&gclid=abc123',
    path: '/products/data-studio',
    title: 'Datasaur - Data Studio',
    referrer: 'https://www.google.com/',
    utm: { utm_source: 'newsletter', gclid: 'abc123' },
    userAgent: CHROME,
    country: 'us',
  })
  check('a page view is stored', first.id.length === 36)
  check('and it opened a session', first.newSession)

  const second = await collect({
    site,
    visitorId: anon,
    at: minutesAgo(119),
    url: 'https://datasaur.ai/pricing',
    path: '/pricing',
    title: 'Pricing',
    userAgent: CHROME,
  })
  check('a view a minute later joins the same session', !second.newSession)

  const third = await collect({
    site,
    visitorId: anon,
    at: minutesAgo(10),
    url: 'https://datasaur.ai/contact-us',
    path: '/contact-us',
    title: 'Contact us',
    userAgent: CHROME,
  })
  check(
    'and one after a two hour gap starts a new one',
    third.newSession,
    'thirty minutes of inactivity, matching GA4',
  )

  const sessions = await scoped<{ n: string }>(
    datasaur,
    sql`select count(*)::text as n from visitor_session where visitor_id = ${anon}`,
  )
  check('so this visitor has two sessions', sessions[0]?.n === '2')

  const stored = await scoped<{ utm: Record<string, string>; country: string; ua_family: string; device: string }>(
    datasaur,
    sql`select utm, country, ua_family, device from page_view where id = ${first.id}`,
  )
  check('campaign parameters are kept verbatim', stored[0]?.utm?.gclid === 'abc123', 'D17')
  check('the country is normalised', stored[0]?.country === 'US')
  check('the browser family is stored, not the whole fingerprint', stored[0]?.ua_family === 'Chrome')
  check('and the device is derived', stored[0]?.device === 'desktop')

  // -------------------------------------------------------------------------
  section('custom events')

  const evented = await collect({
    site,
    visitorId: anon,
    at: minutesAgo(9),
    url: 'https://datasaur.ai/app',
    path: '/app',
    userAgent: CHROME,
    event: { name: 'trial_started', properties: { plan: 'pro', seats: 4 } },
  })
  check('a clean event is stored whole', evented.rejected === undefined)

  const dirty = await collect({
    site,
    visitorId: anon,
    at: minutesAgo(8),
    url: 'https://datasaur.ai/app',
    path: '/app',
    userAgent: CHROME,
    event: { name: 'signed_up', properties: { plan: 'pro', email: 'someone@sandbox.test' } },
  })
  check('an event carrying an email is rejected', dirty.rejected === 'pii')

  const kept = await scoped<{ properties: Record<string, unknown> }>(
    datasaur,
    sql`select properties from custom_event where id = ${dirty.id}`,
  )
  check('the offending property is dropped', kept[0]?.properties.email === undefined)
  check(
    'and the rest of the event is kept',
    kept[0]?.properties.plan === 'pro',
    'losing a real signal because one field was wrong would be worse',
  )

  const notices = await listCollectorNotices(datasaur)
  check(
    'the rejection is visible to an admin',
    notices.some((row) => row.kind === 'pii' && row.key === 'signed_up'),
    'so it can be fixed where it is fired',
  )

  // The day's budget is filled directly rather than by firing two hundred events:
  // the cap is a count of distinct names seen today, so the boundary is the same
  // and the test does not spend two minutes on round trips to prove it.
  await scoped(
    datasaur,
    sql`insert into event_name_day (account_id, day, name)
        select ${datasaur.accountId}, current_date, 'fill_' || ${stamp} || '_' || g
          from generate_series(1, ${EVENT_NAME_CAP}) g
        on conflict do nothing`,
  )
  const overflowed = await collect({
    site,
    visitorId: anon,
    at: minutesAgo(6),
    url: 'https://datasaur.ai/app',
    path: '/app',
    userAgent: CHROME,
    event: { name: `loop_${stamp}_final`, properties: {} },
  })
  check(
    'a loop firing distinct event names is bucketed rather than allowed to grow the table',
    overflowed.rejected === 'cardinality',
    `cap is ${EVENT_NAME_CAP} distinct names a day`,
  )
  const bucketed = await scoped<{ name: string }>(
    datasaur,
    sql`select name from custom_event where id = ${overflowed.id}`,
  )
  check('and it lands under the overflow name', bucketed[0]?.name === OVERFLOW_EVENT)

  // Given back immediately: the budget above is this suite's own, and leaving it
  // full buckets every event any later section fires under the same day.
  await scoped(
    datasaur,
    sql`delete from event_name_day
         where account_id = ${datasaur.accountId} and name like ${`fill_${stamp}_%`}`,
  )

  // -------------------------------------------------------------------------
  section('identity stitching')

  const person = await newContact(datasaur, `stitch-${stamp}`)
  const empty = await websiteActivity(datasaur, person)
  check('a brand new contact starts with nothing', empty.pagesViewed === 0 && empty.siteVisits === 0)

  await aliasFromPublicEdge(datasaur.accountId, {
    visitorId: anon,
    contactId: person,
    via: 'form_submission',
  })

  const pending = await scoped<{ n: string }>(
    datasaur,
    sql`select count(*)::text as n from visitor_alias
         where visitor_id = ${anon} and resolved_at is null`,
  )
  check(
    'identifying writes one row and stops',
    pending[0]?.n === '1',
    'a visitor with 5,000 views must not make a form response wait',
  )

  let moved = 0
  for (let pass = 0; pass < 20; pass++) {
    const result = await backfillVisitor(datasaur, { visitorId: anon, contactId: person })
    moved += result.pageViews + result.events
    if (result.done) break
  }
  await refreshContactActivity(datasaur, person)

  check('the back-fill attributes the history', moved >= 3)

  const filled = await websiteActivity(datasaur, person)
  check('the panel shows the right page count', filled.pagesViewed === 3, `${filled.pagesViewed} pages`)
  check('and the right visit count', filled.siteVisits === 2, `${filled.siteVisits} visits`)
  check('and a most recent visit', filled.lastSeenAt !== null)

  const counts = await timelineCounts(datasaur, { entityType: 'contact', entityId: person })
  check(
    'all three page views are on the timeline',
    counts.page_view === 3,
    'dated when they happened, not when the form was submitted',
  )
  check('and the events too', (counts.custom_event ?? 0) > 0)

  const timeline = await readTimeline(datasaur, {
    entity: { entityType: 'contact', entityId: person },
    types: ['page_view'],
    limit: 10,
  })
  const oldest = timeline.rows.at(-1)
  check(
    'the oldest entry keeps its original timestamp',
    oldest !== undefined && oldest.occurredAt.getTime() < Date.now() - 60 * 60_000,
    'a contact arrives with browsing history, not with three events dated today',
  )

  const again = await backfillVisitor(datasaur, { visitorId: anon, contactId: person })
  check(
    're-running the back-fill is a no-op',
    again.pageViews === 0 && again.events === 0,
    'idempotent by construction: it only touches rows with no contact',
  )

  const afterwards = await collect({
    site,
    visitorId: anon,
    at: new Date(),
    url: 'https://datasaur.ai/docs',
    path: '/docs',
    title: 'Docs',
    userAgent: CHROME,
  })
  const attributed = await readPageView(datasaur, afterwards.id)
  check(
    'a view after identification is attributed immediately',
    attributed?.contactId === person,
    'no waiting for the next back-fill',
  )

  // -------------------------------------------------------------------------
  section('two devices, one person')

  const phone = vid('phone')
  await collect({
    site,
    visitorId: phone,
    at: minutesAgo(300),
    url: 'https://datasaur.ai/blog',
    path: '/blog',
    title: 'Blog',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  })
  await aliasFromPublicEdge(datasaur.accountId, {
    visitorId: phone,
    contactId: person,
    via: 'booking',
  })
  for (let pass = 0; pass < 5; pass++) {
    if ((await backfillVisitor(datasaur, { visitorId: phone, contactId: person })).done) break
  }
  await refreshContactActivity(datasaur, person)

  const bothDevices = await websiteActivity(datasaur, person)
  check('both histories land on the same contact', bothDevices.pagesViewed === 5)
  check('and the panel says how many browsers', bothDevices.devices === 2)

  // -------------------------------------------------------------------------
  section('a shared browser')

  const other = await newContact(datasaur, `shared-${stamp}`)
  await aliasFromPublicEdge(datasaur.accountId, {
    visitorId: anon,
    contactId: other,
    via: 'form_submission',
  })
  const still = await scoped<{ contact_id: string }>(
    datasaur,
    sql`select contact_id from page_view where id = ${first.id}`,
  )
  check(
    'past views stay with the contact they were attributed to',
    still[0]?.contact_id === person,
    'retroactively moving history between people is worse than a stale attribution',
  )
  const nowOwns = await scoped<{ contact_id: string }>(
    datasaur,
    sql`select contact_id from visitor where id = ${anon}`,
  )
  check('and the newest identification wins for future views', nowOwns[0]?.contact_id === other)

  // -------------------------------------------------------------------------
  section('merge and delete')

  const absorbed = await newContact(datasaur, `absorb-${stamp}`)
  const absorbedVid = vid('absorb')
  await collect({
    site,
    visitorId: absorbedVid,
    at: minutesAgo(50),
    url: 'https://datasaur.ai/careers',
    path: '/careers',
    userAgent: CHROME,
  })
  await aliasFromPublicEdge(datasaur.accountId, {
    visitorId: absorbedVid,
    contactId: absorbed,
    via: 'form_submission',
  })
  for (let pass = 0; pass < 5; pass++) {
    if ((await backfillVisitor(datasaur, { visitorId: absorbedVid, contactId: absorbed })).done) break
  }

  const survivor = await newContact(datasaur, `survive-${stamp}`)
  await mergeRecords(datasaur, {
    objectKey: 'contact',
    survivorId: survivor,
    absorbedId: absorbed,
    picks: {},
  })
  await refreshContactActivity(datasaur, survivor)

  const merged = await websiteActivity(datasaur, survivor)
  check('a merged contact keeps their browsing history', merged.pagesViewed === 1)
  const orphans = await scoped<{ n: string }>(
    datasaur,
    sql`select count(*)::text as n from visitor_alias where contact_id = ${absorbed}`,
  )
  check('and the loser is left with no aliases pointing nowhere', orphans[0]?.n === '0')

  // -------------------------------------------------------------------------
  section('a data subject request')

  const exported = await exportContactActivity(datasaur, person)
  check('the export covers page views', exported.pageViews.length === 5)
  check('and the visitors they were identified as', exported.visitors.length === 2)
  check('and is not silently capped', exported.pageViews.length >= bothDevices.pagesViewed)

  const erased = await eraseContactActivity(datasaur, person)
  check('erasure removes the page views', erased.pageViews === 5)
  const afterErase = await timelineCounts(datasaur, { entityType: 'contact', entityId: person })
  check(
    'and the timeline entries they produced',
    (afterErase.page_view ?? 0) === 0,
    'a record still reading "viewed Data Studio" with nothing behind it would be worse',
  )
  const noVisitor = await scoped<{ n: string }>(
    datasaur,
    sql`select count(*)::text as n from visitor where id = ${phone}`,
  )
  check('and the visitor identities that pointed at them', noVisitor[0]?.n === '0')

  const salesCtx = await ctxFor(SANDBOX.slug, ['contacts', 'sales'])
  check(
    'erasure is refused to anybody but an admin',
    await refusesAsync(() => eraseContactActivity(salesCtx, survivor)),
    'enforced in the data access layer, not by hiding a button',
  )
  check(
    'and so is adding a site',
    await refusesAsync(() =>
      createSite(salesCtx, { name: 'No', host: 'datasaur.ai', siteKey: `no-${stamp}` }),
    ),
  )

  // -------------------------------------------------------------------------
  section('retention')

  const oldVid = vid('old')
  const ancient = await collect({
    site,
    visitorId: oldVid,
    at: new Date(Date.now() - 800 * 24 * 60 * 60_000),
    url: 'https://datasaur.ai/old',
    path: '/old',
    userAgent: CHROME,
  })
  const oldPerson = await newContact(datasaur, `old-${stamp}`)
  await aliasFromPublicEdge(datasaur.accountId, {
    visitorId: oldVid,
    contactId: oldPerson,
    via: 'form_submission',
  })
  for (let pass = 0; pass < 5; pass++) {
    if ((await backfillVisitor(datasaur, { visitorId: oldVid, contactId: oldPerson })).done) break
  }
  await refreshContactActivity(datasaur, oldPerson)
  const beforeRollUp = await websiteActivity(datasaur, oldPerson)

  await rollUpExpired(datasaur, 25)
  await refreshContactActivity(datasaur, oldPerson)

  const gone = await readPageView(datasaur, ancient.id)
  check('a page view past the retention window is gone', gone === null)
  const afterRollUp = await websiteActivity(datasaur, oldPerson)
  check(
    'and the count stays honest',
    afterRollUp.pagesViewed === beforeRollUp.pagesViewed,
    'rolled into a daily aggregate rather than lost',
  )

  // -------------------------------------------------------------------------
  section('tenancy')

  const probeSite = await publicSite('peer-www')
  if (!probeSite) throw new Error('the probe site is missing. Run pnpm db:seed.')
  const probeVid = vid(PEER.slug)
  const probeView = await collect({
    site: probeSite,
    visitorId: probeVid,
    at: new Date(),
    url: 'https://probe.example/',
    path: '/',
    userAgent: CHROME,
  })

  check(
    'one tenant cannot read the other tenant’s page view',
    (await readPageView(datasaur, probeView.id)) === null,
  )
  const crossVisitor = await scoped<{ n: string }>(
    datasaur,
    sql`select count(*)::text as n from visitor where id = ${probeVid}`,
  )
  check('nor its visitors', crossVisitor[0]?.n === '0')
  const crossNotices = await listCollectorNotices(probe)
  check(
    'nor the notices its collector raised',
    crossNotices.every((row) => row.key !== 'signed_up'),
  )
  check(
    'and a site key belonging to one tenant resolves only that tenant',
    (await publicSite('peer-www'))?.accountId === probe.accountId,
  )

  // -------------------------------------------------------------------------
  section('extremes')

  const longVid = vid('long')
  const long = 'x'.repeat(500)
  const huge = await collect({
    site,
    visitorId: longVid,
    at: new Date(),
    url: `https://datasaur.ai/${long}`,
    path: `/${long}`,
    title: long,
    referrer: `https://example.com/${long}`,
    userAgent: CHROME,
  })
  const clipped = await readPageView(datasaur, huge.id)
  check(
    'a 500 character title survives a page view',
    clipped?.title?.length === 500,
    'and a longer one is clipped rather than refused',
  )

  const noConsent = await collect({
    site,
    visitorId: vid('single'),
    at: new Date(),
    url: 'https://datasaur.ai/',
    path: '/',
    userAgent: CHROME,
  })
  check('a visitor with exactly one view reads back correctly', (await readPageView(datasaur, noConsent.id)) !== null)

  // -------------------------------------------------------------------------
  section('event definitions and the funnel')

  // The collector registers a name the moment it first sees it, so this reads
  // back a definition nobody typed.
  const defs = await listEventDefs(datasaur, { search: 'trial_started' })
  check(
    'a name the collector saw registers itself',
    defs.rows.some((row) => row.name === 'trial_started' && row.discovered),
    'the settings tab lists what the sites actually fire',
  )

  await saveEventDef(datasaur, {
    name: 'trial_started',
    label: 'Trial started',
    properties: { plan: { type: 'string' } },
  })
  const described = await listEventDefs(datasaur, { search: 'trial_started' })
  check(
    'describing one stops it reading as discovered',
    described.rows.some((row) => row.name === 'trial_started' && !row.discovered && row.label === 'Trial started'),
  )
  check(
    'the overflow bucket is never offered as an event',
    !(await listEventDefs(datasaur, { search: OVERFLOW_EVENT })).rows.some((row) => row.name === OVERFLOW_EVENT),
    'it is the cardinality bucket, not something a site fired',
  )

  const listed = await listEventDefs(datasaur, { limit: 1 })
  check('the list pages rather than returning everything', listed.rows.length <= 1 && listed.total >= 1)

  const walker = vid('funnel')
  for (const [index, name] of ['step_one', 'step_two', 'step_three'].entries()) {
    await collect({
      site,
      visitorId: walker,
      at: minutesAgo(30 - index),
      url: 'https://datasaur.ai/app',
      path: '/app',
      userAgent: CHROME,
      event: { name: `${name}_${stamp}`, properties: {} },
    })
  }
  // Fires the last step only, and before anybody else did: it must not count as
  // having walked the path.
  const skipper = vid('skipper')
  await collect({
    site,
    visitorId: skipper,
    at: minutesAgo(40),
    url: 'https://datasaur.ai/app',
    path: '/app',
    userAgent: CHROME,
    event: { name: `step_three_${stamp}`, properties: {} },
  })

  const window_ = { from: new Date(Date.now() - 2 * 60 * 60_000), to: new Date(Date.now() + 60_000) }
  const funnel = await eventFunnel(datasaur, {
    steps: [`step_one_${stamp}`, `step_two_${stamp}`, `step_three_${stamp}`],
    range: window_,
  })
  check('a funnel answers one row per step, in the order asked for', funnel.length === 3)
  check('the visitor who walked it is counted at every step', (funnel[2]?.visitors ?? 0) >= 1)
  check(
    'somebody who fired the last step first is not counted as having walked it',
    funnel[2]?.visitors === funnel[0]?.visitors,
    'order is what makes it a funnel rather than three counts',
  )

  const backwards = await eventFunnel(datasaur, {
    steps: [`step_three_${stamp}`, `step_one_${stamp}`],
    range: window_,
  })
  check('and reversing the steps reverses the answer', (backwards[1]?.visitors ?? 1) === 0)

  check(
    'one step is not a funnel',
    (await eventFunnel(datasaur, { steps: [`step_one_${stamp}`], range: window_ })).length === 0,
  )

  const peerFunnel = await eventFunnel(probe, {
    steps: [`step_one_${stamp}`, `step_two_${stamp}`],
    range: window_,
  })
  check('the peer tenant counts none of it', peerFunnel.every((step) => step.visitors === 0))

  const counted = await eventCountsByDay(datasaur, window_, [`step_one_${stamp}`])
  check('per-name daily counts come back grouped', counted.every((row) => row.name === `step_one_${stamp}`))
} catch (cause) {
  failures++
  console.error('\nthe suite could not finish:', cause instanceof Error ? cause.message : cause)
} finally {
  console.log(
    failures === 0
      ? `\nall ${checks} activity checks passed.`
      : `\n${failures} of ${checks} activity checks FAILED.`,
  )
  // Given back before exiting, so the next suite in `pnpm verify` does not start
  // against a pooler this one is still holding connections on.
  await closeAppPool()
  await cleanup()
  process.exit(failures === 0 ? 0 : 1)
}

async function refusesAsync(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

async function refusesAsyncWith(fn: () => Promise<unknown>, fragment: string): Promise<boolean> {
  try {
    await fn()
    return false
  } catch (cause) {
    return String(cause instanceof Error ? cause.message : cause).includes(fragment)
  }
}
