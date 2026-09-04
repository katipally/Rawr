import { sql } from 'drizzle-orm'
import { appDb, closeAppPool } from '../src/internal/pool.ts'
import {
  assignHost,
  attachConference,
  bookingForToken,
  bookingTemplateValues,
  cancelBooking,
  computeOffer,
  computeSlots,
  confirmBooking,
  DEFAULT_WEEKLY,
  HOLD_MINUTES,
  dayKey,
  isKnownTimezone,
  listBookingPages,
  listBookings,
  offsetMs,
  placeHold,
  publicBookingPage,
  readBooking,
  readBookingPage,
  readHolds,
  readPageHosts,
  releaseHold,
  readSchedule,
  renderTemplate,
  saveBookingPage,
  saveOverride,
  saveSchedule,
  setPageActive,
  SlotGoneError,
  subtractIntervals,
  withWorkspace,
  zonedTimeToUtc,
  type BookingPageConfig,
  type Candidate,
  type HostAvailability,
  type Interval,
  type Provisioner,
  type Role,
  type WorkspaceContext,
} from '../src/index.ts'

/** F2's definition of done, run against the real database, exiting non-zero on
 *  failure so it can gate a build. Same shape as verify-crm.ts and verify-forms.ts.
 *
 *  Nothing here touches Google or Zoom. The engine takes free-busy and the
 *  conference link as arguments precisely so that this file can ask "what would you
 *  offer if this host were busy from two until four on the Sunday the clocks
 *  change", which no test can ask of a real calendar. */

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

const ctxFor = async (slug: string, role: Role = 'admin'): Promise<WorkspaceContext> => {
  const rows = await appDb.execute<{ id: string }>(
    sql`select id from rawr.workspace_for_site(${slug})`,
  )
  const id = rows[0]?.id
  if (!id) throw new Error(`workspace ${slug} is not seeded. Run pnpm db:seed.`)
  return { workspaceId: id, actorId: null, actorKind: 'user', role }
}

const scoped = <T extends Record<string, unknown>>(
  ctx: WorkspaceContext,
  query: ReturnType<typeof sql>,
): Promise<T[]> => withWorkspace(ctx, (tx) => tx.execute<T>(query) as Promise<T[]>)

const actorCtx = async (slug: string, email: string, role: Role): Promise<WorkspaceContext> => {
  const base = await ctxFor(slug, role)
  const rows = await scoped<{ id: string }>(
    base,
    sql`select id from user_account where email = ${email} limit 1`,
  )
  const actorId = rows[0]?.id
  if (!actorId) throw new Error(`${email} is not a member of ${slug}. Run pnpm db:seed.`)
  return { ...base, actorId }
}

/** Stands in for Google and Zoom. Records what it was asked for so the template
 *  rules can be asserted against what would actually land on a calendar. */
const provisioned: {
  summary: string
  description: string
  requestConference: boolean
  hostEmail: string
}[] = []

const fakeProvisioner: Provisioner = async (request) => {
  const values = bookingTemplateValues({
    attendeeName: request.attendee.name,
    attendeeEmail: request.attendee.email,
    companyName: request.companyName,
    companyFallback: request.page.companyFallback,
    hostName: request.host.name,
    hostEmail: request.host.email,
    pageName: request.page.name,
    durationMinutes: request.page.durationMinutes,
  })
  const summary = renderTemplate(request.page.titleTpl, values)
  const description = renderTemplate(request.page.descriptionTpl, values)
  provisioned.push({
    summary,
    description,
    requestConference: request.page.location === 'google_meet',
    hostEmail: request.host.email,
  })
  return {
    calendarEventId: `evt-${request.startsAt.getTime()}-${request.host.userId.slice(0, 8)}`,
    calendarId: 'primary',
    conferenceUrl: 'https://example.test/join',
    conferenceRef: 'zoom-1',
    warnings: [],
  }
}

const failingCalendar: Provisioner = async () => {
  throw new Error('Google Calendar answered 503.')
}

const noZoom: Provisioner = async () => ({
  calendarEventId: 'evt-nozoom',
  calendarId: 'primary',
  conferenceUrl: null,
  conferenceRef: null,
  warnings: ['No Zoom link yet: Zoom answered 502.'],
})

const iso = (value: Date) => value.toISOString()

const hostFixture = (over: Partial<HostAvailability> = {}): HostAvailability => ({
  userId: over.userId ?? '00000000-0000-0000-0000-000000000001',
  name: over.name ?? 'Host',
  email: over.email ?? 'host@datasaur.ai',
  weight: over.weight ?? 1,
  lastAssignedAt: over.lastAssignedAt ?? null,
  timezone: over.timezone ?? 'America/Los_Angeles',
  weekly: over.weekly ?? DEFAULT_WEEKLY,
  overrides: over.overrides ?? new Map(),
  provider: over.provider ?? 'dev',
  calendarId: over.calendarId ?? 'primary',
  grantState: over.grantState ?? 'connected',
  unavailableReason: over.unavailableReason ?? null,
  rawrBusy: over.rawrBusy ?? [],
  recentAssignments: over.recentAssignments ?? 0,
})

const PAGE_SHAPE = {
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 0,
  maxHorizonDays: 60,
  granularityMinutes: 30,
}

/** The suite writes real bookings, contacts and pages, and it has to be runnable
 *  twice in a row without the second run reading the first one's leftovers. Every
 *  address it books with ends in one of these, and every page it creates is named
 *  here, so the cleanup is exact rather than a truncate. */
const TEST_DOMAINS = ['acme-booking.test', 'race-booking.test']
const TEST_PAGES = ['nobody-home', 'phone-page', 'trevor-personal', 'sales-made-this']

const cleanUp = async (ctx: WorkspaceContext): Promise<void> => {
  await withWorkspace(ctx, async (tx) => {
    const like = sql.join(
      TEST_DOMAINS.map((domain) => sql`b.attendee_email like ${'%@' + domain}`),
      sql` or `,
    )
    await tx.execute(sql`delete from booking b where ${like} or b.attendee_email = 'someone@gmail.com'`)
    await tx.execute(sql`delete from booking_hold`)
    const pages = sql.join(TEST_PAGES.map((slug) => sql`${slug}`), sql`, `)
    await tx.execute(sql`delete from booking_page where slug in (${pages})`)
    await tx.execute(
      sql`delete from contact where ${sql.join(
        TEST_DOMAINS.map((domain) => sql`email like ${'%@' + domain}`),
        sql` or `,
      )} or email = 'someone@gmail.com'`,
    )
    await tx.execute(
      sql`delete from company where ${sql.join(
        TEST_DOMAINS.map((domain) => sql`domain = ${domain}`),
        sql` or `,
      )}`,
    )
    await tx.execute(sql`delete from availability_override where day >= '2026-12-01'`)
  })
}

try {
  const datasaur = await ctxFor('datasaur')
  const probe = await ctxFor('probe')
  await cleanUp(datasaur)
  await cleanUp(probe)

  // -----------------------------------------------------------------------
  section('timezones, the arithmetic everything rests on')

  check('a named zone resolves', isKnownTimezone('Asia/Jakarta'), 'Asia/Jakarta')
  check(
    'a mistyped zone is refused rather than silently becoming UTC',
    !isKnownTimezone('Asia/Jakata') && !isKnownTimezone('Mars/Olympus'),
    'a page whose host has a typo must fail loudly, not quietly offer UTC',
  )

  // Los Angeles: PST is -8, PDT is -7. The offset has to come from the instant.
  const january = new Date('2026-01-15T20:00:00Z')
  const july = new Date('2026-07-15T20:00:00Z')
  check(
    'the offset is read from the instant, not assumed',
    offsetMs(january, 'America/Los_Angeles') === -8 * 3_600_000 &&
      offsetMs(july, 'America/Los_Angeles') === -7 * 3_600_000,
    'Los Angeles is -8 in January and -7 in July',
  )

  check(
    'a zone with a 45 minute offset is handled as itself',
    offsetMs(july, 'Asia/Kathmandu') === 5 * 3_600_000 + 45 * 60_000,
    'Kathmandu is +05:45',
  )

  // 09:00 local on both sides of the spring-forward weekend in Los Angeles
  // (8 March 2026). If the arithmetic used a fixed offset, one of these would be
  // an hour out.
  const beforeSpring = zonedTimeToUtc('2026-03-07', 9 * 60, 'America/Los_Angeles')
  const afterSpring = zonedTimeToUtc('2026-03-09', 9 * 60, 'America/Los_Angeles')
  check(
    'nine in the morning stays nine across spring forward',
    iso(beforeSpring) === '2026-03-07T17:00:00.000Z' && iso(afterSpring) === '2026-03-09T16:00:00.000Z',
    'the absolute instant moves by an hour, the wall clock does not',
  )

  // And the southern hemisphere, where the transition runs the other way.
  // Sydney leaves daylight time on 5 April 2026.
  const beforeAutumn = zonedTimeToUtc('2026-04-04', 9 * 60, 'Australia/Sydney')
  const afterAutumn = zonedTimeToUtc('2026-04-06', 9 * 60, 'Australia/Sydney')
  check(
    'and across fall back in the southern hemisphere',
    iso(beforeAutumn) === '2026-04-03T22:00:00.000Z' && iso(afterAutumn) === '2026-04-05T23:00:00.000Z',
    'Sydney +11 becomes +10',
  )

  // -----------------------------------------------------------------------
  section('interval arithmetic')

  const cut = subtractIntervals(
    [{ start: new Date('2026-09-01T09:00:00Z'), end: new Date('2026-09-01T17:00:00Z') }],
    [
      { start: new Date('2026-09-01T10:00:00Z'), end: new Date('2026-09-01T11:00:00Z') },
      { start: new Date('2026-09-01T10:30:00Z'), end: new Date('2026-09-01T12:00:00Z') },
    ],
  )
  check(
    'overlapping busy blocks are merged before they are subtracted',
    cut.length === 2 && iso(cut[0]!.end) === '2026-09-01T10:00:00.000Z' && iso(cut[1]!.start) === '2026-09-01T12:00:00.000Z',
    'two windows left, not three',
  )

  const swallowed = subtractIntervals(
    [{ start: new Date('2026-09-01T09:00:00Z'), end: new Date('2026-09-01T10:00:00Z') }],
    [{ start: new Date('2026-09-01T08:00:00Z'), end: new Date('2026-09-01T18:00:00Z') }],
  )
  check('a day entirely blocked leaves nothing', swallowed.length === 0)

  // -----------------------------------------------------------------------
  section('what is offered')

  const monday = { from: new Date('2026-09-07T00:00:00Z'), to: new Date('2026-09-08T00:00:00Z') }
  const laHost = {
    ...PAGE_SHAPE,
    from: monday.from,
    to: monday.to,
    now: new Date('2026-09-01T00:00:00Z'),
    timezone: 'America/Los_Angeles',
    weekly: DEFAULT_WEEKLY,
    overrides: new Map(),
    busy: [] as Interval[],
  }

  const fullDay = computeSlots(laHost)
  check(
    'nine to five at half hour steps is sixteen slots',
    fullDay.length === 16,
    `${fullDay.length} slots, first ${iso(fullDay[0] ?? new Date(0))}`,
  )
  check(
    'the first slot is nine in the host’s own morning',
    iso(fullDay[0] ?? new Date(0)) === '2026-09-07T16:00:00.000Z',
    '09:00 PDT',
  )
  check(
    'the last slot ends at five, never after it',
    iso(fullDay.at(-1) ?? new Date(0)) === '2026-09-07T23:30:00.000Z',
    '16:30 PDT, ending at 17:00',
  )

  const withBusy = computeSlots({
    ...laHost,
    busy: [{ start: new Date('2026-09-07T18:00:00Z'), end: new Date('2026-09-07T19:00:00Z') }],
  })
  check(
    'a busy hour removes exactly the slots it covers',
    withBusy.length === 14 && !withBusy.some((slot) => iso(slot) === '2026-09-07T18:00:00.000Z'),
    'two half-hour slots gone',
  )

  const withBuffers = computeSlots({
    ...laHost,
    bufferBeforeMinutes: 30,
    bufferAfterMinutes: 30,
    busy: [{ start: new Date('2026-09-07T18:00:00Z'), end: new Date('2026-09-07T19:00:00Z') }],
  })
  check(
    'buffers widen a commitment on both sides',
    withBuffers.length === 12 &&
      !withBuffers.some((slot) => iso(slot) === '2026-09-07T17:30:00.000Z') &&
      !withBuffers.some((slot) => iso(slot) === '2026-09-07T19:00:00.000Z'),
    'the half hours either side go too',
  )

  const noticed = computeSlots({
    ...laHost,
    now: new Date('2026-09-07T16:00:00Z'),
    minNoticeMinutes: 240,
  })
  check(
    'nothing inside the notice period is offered',
    noticed.every((slot) => slot.getTime() >= new Date('2026-09-07T20:00:00Z').getTime()),
    'four hours from now',
  )

  const horizoned = computeSlots({
    ...laHost,
    now: new Date('2026-09-01T00:00:00Z'),
    maxHorizonDays: 3,
  })
  check('nothing past the horizon is offered', horizoned.length === 0, '7 September is beyond 3 days')

  const weekend = computeSlots({
    ...laHost,
    from: new Date('2026-09-05T00:00:00Z'),
    to: new Date('2026-09-06T00:00:00Z'),
  })
  check('a day with no weekly window offers nothing', weekend.length === 0, 'Saturday')

  const overridden = computeSlots({
    ...laHost,
    overrides: new Map([['2026-09-07', { isUnavailable: true, blocks: [] }]]),
  })
  check('a day marked unavailable offers nothing at all', overridden.length === 0)

  const shortDay = computeSlots({
    ...laHost,
    overrides: new Map([['2026-09-07', { isUnavailable: false, blocks: [['14:00', '16:00']] }]]),
  })
  check(
    'an override replaces the weekly rule rather than adding to it',
    shortDay.length === 4 && iso(shortDay[0]!) === '2026-09-07T21:00:00.000Z',
    'two hours, four slots, from 14:00 local',
  )

  const noHours = computeSlots({ ...laHost, weekly: {} })
  check('a host with no hours set offers nothing', noHours.length === 0)

  const kathmandu = computeSlots({
    ...laHost,
    timezone: 'Asia/Kathmandu',
    weekly: { '1': [['09:00', '11:00']] },
  })
  check(
    'the grid is measured from the host’s own midnight, not the UTC hour',
    kathmandu.length === 4 && iso(kathmandu[0]!).endsWith('03:15:00.000Z'),
    '09:00 in Kathmandu is 03:15Z, so slots land on :15 and :45 in UTC',
  )

  // A window that spans the DST transition, resolved against the date.
  const springDay = computeSlots({
    ...laHost,
    from: new Date('2026-03-08T00:00:00Z'),
    to: new Date('2026-03-09T12:00:00Z'),
    now: new Date('2026-03-01T00:00:00Z'),
    weekly: { ...DEFAULT_WEEKLY, '7': [['09:00', '17:00']] },
  })
  check(
    'the spring-forward Sunday still offers its own local nine to five',
    springDay.some((slot) => iso(slot) === '2026-03-08T16:00:00.000Z'),
    '09:00 PDT on the day the clocks moved',
  )

  // -----------------------------------------------------------------------
  section('a host without a working calendar is unavailable, never free')

  const readable = hostFixture({ userId: '00000000-0000-0000-0000-00000000000a', name: 'Readable' })
  const unreadable = hostFixture({ userId: '00000000-0000-0000-0000-00000000000b', name: 'Unreadable' })
  const ungranted = hostFixture({
    userId: '00000000-0000-0000-0000-00000000000c',
    name: 'Ungranted',
    grantState: 'unconfigured',
    unavailableReason: 'Ungranted has not connected a calendar, so no slots can be offered for them.',
  })

  const offer = computeOffer({
    page: PAGE_SHAPE,
    hosts: [readable, unreadable, ungranted],
    // Unreadable is absent from the map: their free-busy call failed.
    externalBusy: new Map([[readable.userId, []]]),
    holds: new Map(),
    from: monday.from,
    to: monday.to,
    now: new Date('2026-09-01T00:00:00Z'),
  })
  check(
    'only the host whose calendar was actually read is offered',
    offer.slots.length === 16 && offer.slots.every((slot) => slot.hostUserIds.length === 1),
    'sixteen slots, one host each',
  )
  check(
    'both the unreadable and the unconnected host are reported with a reason',
    offer.problems.length === 2 && offer.problems.some((line) => line.includes('could not be read')),
    offer.problems.join(' | '),
  )

  const twoFree = computeOffer({
    page: PAGE_SHAPE,
    hosts: [readable, unreadable],
    externalBusy: new Map([
      [readable.userId, []],
      [unreadable.userId, []],
    ]),
    holds: new Map(),
    from: monday.from,
    to: monday.to,
    now: new Date('2026-09-01T00:00:00Z'),
  })
  check(
    'a round robin offers a slot if anybody can take it',
    twoFree.slots.every((slot) => slot.hostUserIds.length === 2),
    'both hosts on every slot',
  )

  const oneHeld = computeOffer({
    page: PAGE_SHAPE,
    hosts: [readable, unreadable],
    externalBusy: new Map([
      [readable.userId, []],
      [unreadable.userId, []],
    ]),
    holds: new Map([[new Date('2026-09-07T16:00:00Z').getTime(), 1]]),
    from: monday.from,
    to: monday.to,
    now: new Date('2026-09-01T00:00:00Z'),
  })
  check(
    'a hold reserves capacity, not the slot',
    oneHeld.slots.length === 16,
    'two free hosts, one hold, the slot stays open',
  )

  const bothHeld = computeOffer({
    page: PAGE_SHAPE,
    hosts: [readable, unreadable],
    externalBusy: new Map([
      [readable.userId, []],
      [unreadable.userId, []],
    ]),
    holds: new Map([[new Date('2026-09-07T16:00:00Z').getTime(), 2]]),
    from: monday.from,
    to: monday.to,
    now: new Date('2026-09-01T00:00:00Z'),
  })
  check(
    'once every host is held the slot stops being offered',
    bothHeld.slots.length === 15,
    'nine o’clock is gone',
  )

  const noHosts = computeOffer({
    page: PAGE_SHAPE,
    hosts: [],
    externalBusy: new Map(),
    holds: new Map(),
    from: monday.from,
    to: monday.to,
    now: new Date('2026-09-01T00:00:00Z'),
  })
  check('a page with no hosts offers nothing and says nothing false', noHosts.slots.length === 0)

  // -----------------------------------------------------------------------
  section('round robin')

  const candidates = [
    { userId: 'a', weight: 2, lastAssignedAt: null, recentAssignments: 0 },
    { userId: 'b', weight: 1, lastAssignedAt: null, recentAssignments: 0 },
  ]
  const tally = { a: 0, b: 0 }
  const counted: Candidate[] = candidates.map((candidate) => ({ ...candidate }))
  for (let i = 0; i < 300; i++) {
    const chosen = assignHost(counted, `slot-${i}`)
    if (chosen === 'a') tally.a++
    else tally.b++
    const row = counted.find((candidate) => candidate.userId === chosen)
    if (row) {
      row.recentAssignments++
      row.lastAssignedAt = new Date(2026, 0, 1, 0, i)
    }
  }
  const ratio = tally.a / tally.b
  check(
    'weight two takes twice as many meetings as weight one',
    Math.abs(ratio - 2) < 0.05,
    `${tally.a} to ${tally.b}, ratio ${ratio.toFixed(3)}`,
  )

  const firstPick = assignHost(candidates, 'fixed')
  const secondPick = assignHost(candidates, 'fixed')
  check(
    'the same inputs pick the same host every time',
    firstPick === secondPick,
    `deterministic, so a test can assert it: ${firstPick} twice`,
  )

  check(
    'the person waiting longest breaks a tie on share',
    assignHost(
      [
        { userId: 'recent', weight: 1, lastAssignedAt: new Date('2026-09-01T00:00:00Z'), recentAssignments: 1 },
        { userId: 'stale', weight: 1, lastAssignedAt: new Date('2026-01-01T00:00:00Z'), recentAssignments: 1 },
      ],
      'seed',
    ) === 'stale',
  )

  check('no candidates means no assignment, never a guess', assignHost([], 'seed') === null)

  // -----------------------------------------------------------------------
  section('templates')

  const withCompany = bookingTemplateValues({
    attendeeName: 'Priya Raman',
    attendeeEmail: 'priya@acme.com',
    companyName: 'Acme',
    companyFallback: 'a new team',
    hostName: 'Admin',
    hostEmail: 'admin@datasaur.ai',
    pageName: 'Talk to sales',
    durationMinutes: 30,
  })
  check(
    'a resolved title reads as the production string',
    renderTemplate('Discovery Session with Datasaur <> {{company.name}}', withCompany) ===
      'Discovery Session with Datasaur <> Acme',
  )

  const withoutCompany = bookingTemplateValues({
    attendeeName: 'Priya',
    attendeeEmail: 'priya@gmail.com',
    companyName: null,
    companyFallback: 'a new team',
    hostName: 'Admin',
    hostEmail: 'admin@datasaur.ai',
    pageName: 'Talk to sales',
    durationMinutes: 30,
  })
  check(
    'an unknown company falls back rather than trailing off',
    renderTemplate('Discovery Session with Datasaur <> {{company.name}}', withoutCompany) ===
      'Discovery Session with Datasaur <> a new team',
  )

  check(
    'a variable nothing can fill renders as nothing, never as "undefined"',
    renderTemplate('Call with {{contact.first_name}} {{nonsense.key}}', withCompany) === 'Call with Priya',
    'and the dangling space goes with it',
  )

  check(
    'a title whose tail resolves to nothing does not end in a separator',
    renderTemplate('Datasaur <> {{nonsense.key}}', withCompany) === 'Datasaur',
  )

  // -----------------------------------------------------------------------
  section('confirming a booking, against the real database')

  const page = await bySlug(datasaur, 'sales-team')
  const hosts = await readPageHosts(datasaur, page.bookingPageId, {
    from: new Date('2026-09-01T00:00:00Z'),
    to: new Date('2026-12-01T00:00:00Z'),
  })
  check(
    'the seeded round robin has its three hosts, all with hours and a calendar',
    hosts.length === 3 && hosts.every((host) => host.unavailableReason === null),
    hosts.map((host) => `${host.name}/${host.timezone}`).join(', '),
  )

  const slotOne = new Date('2026-09-07T17:00:00.000Z')
  const result = await confirmBooking(
    datasaur,
    {
      page,
      startsAt: slotOne,
      body: { name: 'Priya Raman', email: 'priya@acme-booking.test', interest: 'labeling' },
      attendeeTimezone: 'Asia/Jakarta',
      attribution: { pagePath: '/b/datasaur/sales-team' },
    },
    hosts,
    fakeProvisioner,
  )
  check('a booking is confirmed and returns its host', !!result.bookingId && !!result.hostUserId, result.hostName)
  check('the contact was created', !!result.contactId)
  check('and the company, from the address domain', !!result.companyId)

  const timeline = await scoped<{ n: string }>(
    datasaur,
    sql`select count(*) as n from activity_link l
          join activity a on a.id = l.activity_id
         where a.type = 'booking' and l.entity_id = ${result.contactId}`,
  )
  check('a booking activity is on the contact', Number(timeline[0]?.n ?? 0) === 1)

  const companyTimeline = await scoped<{ n: string }>(
    datasaur,
    sql`select count(*) as n from activity_link where entity_id = ${result.companyId} and type = 'booking'`,
  )
  check('and on the company', Number(companyTimeline[0]?.n ?? 0) === 1)

  const audit = await scoped<{ action: string; actor_kind: string }>(
    datasaur,
    sql`select action, actor_kind from audit_log where entity = 'booking' and entity_id = ${result.bookingId}`,
  )
  check(
    'the mutation is audited, attributed to the real actor',
    audit[0]?.action === 'create',
    `action ${audit[0]?.action}`,
  )

  // The company was created from the address domain, so its name is the domain's
  // first label until somebody edits it. That is F1's rule, not F2's to change.
  const eventTitle = provisioned.at(-1)
  check(
    'the calendar event carries the templated title with real values in it',
    eventTitle?.summary === 'Discovery Session with Datasaur <> acme-booking',
    eventTitle?.summary ?? '(nothing was provisioned)',
  )

  // Same slot, same page: every host who is free is offered it, but the one just
  // assigned is now busy.
  const afterFirst = await readPageHosts(datasaur, page.bookingPageId, {
    from: slotOne,
    to: new Date(slotOne.getTime() + 3_600_000),
  })
  const stillFree = afterFirst.filter(
    (host) => !host.rawrBusy.some((busy) => busy.start.getTime() === slotOne.getTime()),
  )
  check(
    'the assigned host is now busy for that instant on every page they host',
    stillFree.length === afterFirst.length - 1,
    `${stillFree.length} of ${afterFirst.length} still free`,
  )

  // -----------------------------------------------------------------------
  section('two people racing for the last slot')

  const soleHost = [afterFirst.find((host) => host.userId === result.hostUserId)!]
  const raceSlot = new Date('2026-09-08T17:00:00.000Z')
  const race = await Promise.allSettled([
    confirmBooking(
      datasaur,
      {
        page,
        startsAt: raceSlot,
        body: { name: 'First Racer', email: 'first@race-booking.test' },
        attendeeTimezone: 'UTC',
        attribution: {},
      },
      soleHost,
      fakeProvisioner,
    ),
    confirmBooking(
      datasaur,
      {
        page,
        startsAt: raceSlot,
        body: { name: 'Second Racer', email: 'second@race-booking.test' },
        attendeeTimezone: 'UTC',
        attribution: {},
      },
      soleHost,
      fakeProvisioner,
    ),
  ])

  const won = race.filter((outcome) => outcome.status === 'fulfilled')
  const lost = race.filter(
    (outcome) => outcome.status === 'rejected' && outcome.reason instanceof SlotGoneError,
  )
  check(
    'one booking wins and the other is told the slot went',
    won.length === 1 && lost.length === 1,
    `${won.length} confirmed, ${lost.length} refused`,
  )

  const doubled = await scoped<{ n: string }>(
    datasaur,
    sql`select count(*) as n from booking
         where host_user_id = ${soleHost[0]!.userId}
           and starts_at = ${raceSlot.toISOString()}::timestamptz and state = 'confirmed'`,
  )
  check('and there is exactly one confirmed booking at that instant', Number(doubled[0]?.n ?? 0) === 1)

  // -----------------------------------------------------------------------
  section('failures, and what each one writes')

  const calendarFailed = await refusesAsync(() =>
    confirmBooking(
      datasaur,
      {
        page,
        startsAt: new Date('2026-09-09T17:00:00.000Z'),
        body: { name: 'Rolled Back', email: 'rollback@race-booking.test' },
        attendeeTimezone: 'UTC',
        attribution: {},
      },
      soleHost,
      failingCalendar,
    ),
  )
  check('a calendar failure refuses the booking', calendarFailed)

  const orphan = await scoped<{ n: string }>(
    datasaur,
    sql`select count(*) as n from contact where email = 'rollback@race-booking.test'`,
  )
  check(
    'and writes nothing at all, not even the contact',
    Number(orphan[0]?.n ?? 0) === 0,
    'a CRM booking with no calendar event is worse than no booking',
  )

  const zoomDown = await confirmBooking(
    datasaur,
    {
      page,
      startsAt: new Date('2026-09-10T17:00:00.000Z'),
      body: { name: 'No Zoom', email: 'nozoom@race-booking.test' },
      attendeeTimezone: 'UTC',
      attribution: {},
    },
    soleHost,
    noZoom,
  )
  check(
    'a Zoom outage still confirms the meeting',
    !!zoomDown.bookingId && zoomDown.conferenceUrl === null,
    'losing a booking over a Zoom outage is the wrong trade',
  )
  check(
    'and the host is told why there is no link',
    zoomDown.warnings.some((warning) => warning.includes('Zoom')),
    zoomDown.warnings.join(' | '),
  )

  const attached = await attachConference(datasaur, zoomDown.bookingId, {
    url: 'https://zoom.test/j/86420',
    ref: '86420',
  })
  check('a link that arrives later attaches to the meeting it belongs to', attached)

  const attachedTwice = await attachConference(datasaur, zoomDown.bookingId, {
    url: 'https://zoom.test/j/99999',
    ref: '99999',
  })
  check(
    'and a second retry does not hand out a second link',
    !attachedTwice,
    'two join links on one meeting is worse than one',
  )

  const backfilled = await readBooking(datasaur, zoomDown.bookingId)
  check(
    'the meeting keeps the first link it was given',
    backfilled?.conferenceUrl === 'https://zoom.test/j/86420',
    backfilled?.conferenceUrl ?? 'none',
  )

  const badAnswers = await confirmBooking(
    datasaur,
    {
      page,
      startsAt: new Date('2026-09-11T17:00:00.000Z'),
      body: { name: 'No Address', email: 'not-an-address' },
      attendeeTimezone: 'UTC',
      attribution: {},
    },
    soleHost,
    fakeProvisioner,
  )
  check(
    'a malformed address names itself and writes nothing',
    (badAnswers.errors?.length ?? 0) > 0 && badAnswers.bookingId === '',
    badAnswers.errors?.map((error) => error.message).join(' ') ?? '',
  )

  const unknownAnswer = await confirmBooking(
    datasaur,
    {
      page,
      startsAt: new Date('2026-09-11T17:00:00.000Z'),
      body: { name: 'Sneaky', email: 'sneaky@race-booking.test', is_admin: 'true' },
      attendeeTimezone: 'UTC',
      attribution: {},
    },
    soleHost,
    fakeProvisioner,
  )
  check(
    'an answer to a question the page does not ask is refused, not stored',
    (unknownAnswer.errors?.length ?? 0) > 0,
    unknownAnswer.errors?.[0]?.message ?? '',
  )

  const freeMail = await confirmBooking(
    datasaur,
    {
      page,
      startsAt: new Date('2026-09-14T17:00:00.000Z'),
      body: { name: 'Personal Address', email: 'someone@gmail.com' },
      attendeeTimezone: 'UTC',
      attribution: {},
    },
    soleHost,
    fakeProvisioner,
  )
  check(
    'a free-mail address books successfully and creates no company',
    !!freeMail.bookingId && freeMail.companyId === null,
  )

  // -----------------------------------------------------------------------
  section('the same person booking twice')

  const returning = await confirmBooking(
    datasaur,
    {
      page,
      startsAt: new Date('2026-09-15T17:00:00.000Z'),
      body: { name: 'P', email: 'priya@acme-booking.test' },
      attendeeTimezone: 'UTC',
      attribution: {},
    },
    soleHost,
    fakeProvisioner,
  )
  check(
    'an address that already exists updates the contact rather than duplicating it',
    returning.contactId === result.contactId,
  )

  const names = await scoped<{ first_name: string | null }>(
    datasaur,
    sql`select first_name from contact where id = ${result.contactId}`,
  )
  check(
    'and a half-typed name does not overwrite the one already on the record',
    names[0]?.first_name === 'Priya',
    `first_name is "${names[0]?.first_name}"`,
  )

  // -----------------------------------------------------------------------
  section('cancel and reschedule')

  const cancelled = await cancelBooking(datasaur, zoomDown.bookingId, { by: 'host', reason: 'testing' })
  check('cancelling works', !cancelled.alreadyDone && cancelled.booking.state === 'cancelled')

  const again = await cancelBooking(datasaur, zoomDown.bookingId, { by: 'host' })
  check('cancelling twice cancels once', again.alreadyDone, 'safe to click twice')

  const cancelActivity = await scoped<{ n: string }>(
    datasaur,
    sql`select count(*) as n from activity where type = 'booking' and subject like 'cancelled %'`,
  )
  check('a cancellation is on the timeline', Number(cancelActivity[0]?.n ?? 0) >= 1)

  const freedSlot = await scoped<{ n: string }>(
    datasaur,
    sql`select count(*) as n from booking
         where host_user_id = ${soleHost[0]!.userId}
           and starts_at = '2026-09-10T17:00:00.000Z'::timestamptz and state = 'confirmed'`,
  )
  check('and the slot it held is free again', Number(freedSlot[0]?.n ?? 0) === 0)

  const moved = await confirmBooking(
    datasaur,
    {
      page,
      startsAt: new Date('2026-09-16T17:00:00.000Z'),
      body: { name: 'Priya Raman', email: 'priya@acme-booking.test' },
      attendeeTimezone: 'UTC',
      attribution: {},
      rescheduleOf: result.bookingId,
    },
    soleHost,
    fakeProvisioner,
  )
  const oldRow = await readBooking(datasaur, result.bookingId)
  check(
    'the old booking becomes rescheduled rather than disappearing',
    oldRow?.state === 'rescheduled',
    `old state ${oldRow?.state}`,
  )
  const chain = await scoped<{ reschedule_of: string | null }>(
    datasaur,
    sql`select reschedule_of from booking where id = ${moved.bookingId}`,
  )
  check('and the new one points back at it', chain[0]?.reschedule_of === result.bookingId)

  // -----------------------------------------------------------------------
  section('tokens')

  const byCancelToken = await bookingForToken('cancel', moved.cancelToken)
  check('a cancel token resolves its own booking with no session', byCancelToken?.id === moved.bookingId)

  const wrongPurpose = await bookingForToken('reschedule', moved.cancelToken)
  check(
    'a cancel token cannot be used to reschedule',
    wrongPurpose === null,
    'single purpose, enforced in the resolver',
  )

  const guessed = await bookingForToken('cancel', 'a'.repeat(43))
  check('a guessed token resolves nothing', guessed === null)
  check('and a short one is refused before it reaches the database', (await bookingForToken('cancel', 'short')) === null)

  // -----------------------------------------------------------------------
  section('holds')

  const holdSlot = new Date('2026-09-17T17:00:00.000Z')
  const held = await placeHold(datasaur.workspaceId, page.bookingPageId, holdSlot)
  const holds = await readHolds(datasaur, page.bookingPageId, {
    from: new Date('2026-09-17T00:00:00Z'),
    to: new Date('2026-09-18T00:00:00Z'),
  })
  check('a hold is counted against its slot', holds.get(holdSlot.getTime()) === 1, `token ${held.token.slice(0, 8)}…`)
  check('and it expires rather than living forever', held.expiresAt.getTime() > Date.now())
  check(
    'the expiry is the five minutes the widget counts down',
    Math.round((held.expiresAt.getTime() - Date.now()) / 60_000) === HOLD_MINUTES,
    `${HOLD_MINUTES} minutes`,
  )

  // Aged deliberately rather than waited out: the widget shows the countdown
  // reaching zero, and what has to be true then is that the slot is offered again.
  await withWorkspace(datasaur, (tx) =>
    tx.execute(sql`
      update booking_hold set expires_at = now() - interval '1 minute'
       where token = ${held.token}`),
  )
  const afterExpiry = await readHolds(datasaur, page.bookingPageId, {
    from: new Date('2026-09-17T00:00:00Z'),
    to: new Date('2026-09-18T00:00:00Z'),
  })
  check(
    'an expired hold stops holding, so the slot comes back',
    afterExpiry.get(holdSlot.getTime()) === undefined,
  )

  const released = await placeHold(datasaur.workspaceId, page.bookingPageId, holdSlot)
  await releaseHold(datasaur.workspaceId, released.token)
  const afterRelease = await readHolds(datasaur, page.bookingPageId, {
    from: new Date('2026-09-17T00:00:00Z'),
    to: new Date('2026-09-18T00:00:00Z'),
  })
  check(
    'and somebody who changes their mind gives it back immediately',
    afterRelease.get(holdSlot.getTime()) === undefined,
  )

  // -----------------------------------------------------------------------
  section('publishing rules')

  const emptyPage = await saveBookingPage(datasaur, {
    slug: 'nobody-home',
    name: 'Nobody home',
    kind: 'round_robin',
    ...PAGE_SHAPE,
    location: 'zoom',
    titleTpl: 'Meeting',
    descriptionTpl: '',
    companyFallback: 'a new team',
    questions: [],
    isActive: false,
    hosts: [],
  })
  check('a round robin with no hosts can be created but not published', !!emptyPage)
  check(
    'and publishing it is refused with a reason',
    await refusesAsync(() => setPageActive(datasaur, emptyPage, true)),
    'caught in the admin, not by a visitor',
  )

  const badSlug = await refusesAsync(() =>
    saveBookingPage(datasaur, {
      slug: 'Not A Slug',
      name: 'Bad',
      kind: 'round_robin',
      ...PAGE_SHAPE,
      location: 'zoom',
      titleTpl: 'x',
      descriptionTpl: '',
      companyFallback: 'x',
      questions: [],
      isActive: false,
      hosts: [],
    }),
  )
  check('a slug with spaces and capitals is refused', badSlug)

  const phoneWithoutNumber = await refusesAsync(() =>
    saveBookingPage(datasaur, {
      slug: 'phone-page',
      name: 'Phone',
      kind: 'round_robin',
      ...PAGE_SHAPE,
      location: 'phone',
      titleTpl: 'x',
      descriptionTpl: '',
      companyFallback: 'x',
      questions: [],
      isActive: false,
      hosts: [],
    }),
  )
  check('a phone meeting with no number is refused', phoneWithoutNumber)

  await setPageActive(datasaur, page.bookingPageId, false)
  const deactivated = await readBookingPage(datasaur, page.bookingPageId)
  check('a page can be taken offline', deactivated?.isActive === false)
  const stillReschedulable = await readBooking(datasaur, moved.bookingId)
  check(
    'and its existing bookings still stand',
    stillReschedulable?.state === 'confirmed',
    'existing meetings are not cancelled by unpublishing',
  )
  await setPageActive(datasaur, page.bookingPageId, true)

  // -----------------------------------------------------------------------
  section('roles')

  const viewer = await actorCtx('datasaur', 'viewer@datasaur.ai', 'viewer')
  check(
    'a viewer can read the booked list',
    (await listBookings(viewer, { when: 'upcoming' })).rows.length >= 0,
    'reading is allowed',
  )
  check(
    'a viewer cannot change a page',
    await refusesAsync(() => setPageActive(viewer, page.bookingPageId, false)),
    'refused in the data access layer',
  )
  check(
    'a viewer cannot change availability',
    await refusesAsync(() => saveSchedule(viewer, { userId: viewer.actorId!, timezone: 'UTC', weekly: {} })),
  )

  const sales = await actorCtx('datasaur', 'sales@datasaur.ai', 'sales')
  check(
    'sales cannot create a shared round robin',
    await refusesAsync(() =>
      saveBookingPage(sales, {
        slug: 'sales-made-this',
        name: 'Nope',
        kind: 'round_robin',
        ...PAGE_SHAPE,
        location: 'zoom',
        titleTpl: 'x',
        descriptionTpl: '',
        companyFallback: 'x',
        questions: [],
        isActive: false,
        hosts: [],
      }),
    ),
    'a shared page belongs to the workspace',
  )

  const ownLink = await saveBookingPage(sales, {
    slug: 'trevor-personal',
    name: 'Time with Trevor',
    kind: 'one_on_one',
    ...PAGE_SHAPE,
    location: 'zoom',
    titleTpl: '{{host.name}} <> {{company.name}}',
    descriptionTpl: '',
    companyFallback: 'you',
    questions: [],
    isActive: false,
  })
  check('but sales can create their own personal link without admin rights', !!ownLink)

  const ownPage = await readBookingPage(sales, ownLink)
  check('which is owned by them and hosted by them', ownPage?.ownerId === sales.actorId)
  const ownHosts = await readPageHosts(sales, ownLink, {
    from: new Date('2026-09-01T00:00:00Z'),
    to: new Date('2026-10-01T00:00:00Z'),
  })
  check('with themselves as the only host', ownHosts.length === 1 && ownHosts[0]?.userId === sales.actorId)

  const marketing = await actorCtx('datasaur', 'marketing@datasaur.ai', 'marketing')
  check(
    'somebody else cannot change that personal link',
    await refusesAsync(() => setPageActive(marketing, ownLink, true)),
    'a personal link is private to its owner',
  )
  check(
    'nor somebody else’s working hours',
    await refusesAsync(() =>
      saveSchedule(marketing, { userId: sales.actorId!, timezone: 'UTC', weekly: {} }),
    ),
  )

  const visible = await listBookingPages(marketing)
  check(
    'and it is not even listed for them',
    !visible.some((row) => row.id === ownLink),
    `${visible.length} pages visible to marketing`,
  )

  // -----------------------------------------------------------------------
  section('tenancy')

  const probePage = await bySlug(probe, 'sales-team')
  check('both tenants have a page on the same slug', probePage.bookingPageId !== page.bookingPageId)

  const crossRead = await readBookingPage(probe, page.bookingPageId)
  check('one tenant cannot read the other’s page', crossRead === null)

  const crossBooking = await readBooking(probe, moved.bookingId)
  check('nor its bookings', crossBooking === null)

  const crossCancel = await refusesAsync(() => cancelBooking(probe, moved.bookingId, { by: 'host' }))
  check('nor cancel one', crossCancel)

  const probeBookings = await listBookings(probe, { when: 'upcoming' })
  check('and its own list is empty rather than everybody’s', probeBookings.rows.length === 0)

  const probeHosts = await readPageHosts(probe, probePage.bookingPageId, {
    from: new Date('2026-09-01T00:00:00Z'),
    to: new Date('2026-10-01T00:00:00Z'),
  })
  check(
    'the other tenant’s hosts are its own',
    probeHosts.length === 1,
    `${probeHosts.length} host on the probe tenant`,
  )

  const publicPage = await publicBookingPage('datasaur', 'sales-team')
  check(
    'the public resolver returns a page without its templates',
    publicPage !== null && !('titleTpl' in publicPage),
    'an event title is internal and can name a deal',
  )
  check(
    'and nothing at all for an address that does not exist',
    (await publicBookingPage('datasaur', 'no-such-page')) === null,
  )
  check(
    'the public page says who the meeting is with',
    (publicPage?.hostNames.length ?? 0) === 3,
    `${publicPage?.hostNames.length ?? 0} names on the round robin`,
  )
  check(
    'and never an address, because the page is public',
    (publicPage?.hostNames ?? []).every((name) => !name.includes('@')),
    (publicPage?.hostNames ?? []).join(', '),
  )

  // -----------------------------------------------------------------------
  section('overrides through the layer')

  const scheduleBefore = await readSchedule(datasaur, hosts[0]!.userId)
  check('a seeded schedule reads back with its zone', !!scheduleBefore.timezone, scheduleBefore.timezone)

  const holiday = dayKey(new Date('2026-12-25T12:00:00Z'), 'UTC')
  await saveOverride(datasaur, {
    userId: hosts[0]!.userId,
    day: holiday,
    isUnavailable: true,
    blocks: [],
    note: 'Christmas',
  })
  const scheduleAfter = await readSchedule(datasaur, hosts[0]!.userId)
  check(
    'an override is stored and read back',
    scheduleAfter.overrides.some((row) => row.day === holiday && row.isUnavailable),
    holiday,
  )

  const emptyHours = await refusesAsync(() =>
    saveOverride(datasaur, {
      userId: hosts[0]!.userId,
      day: '2026-12-26',
      isUnavailable: false,
      blocks: [],
    }),
  )
  check('a working-hours override with no hours in it is refused', emptyHours)

  const badZone = await refusesAsync(() =>
    saveSchedule(datasaur, { userId: hosts[0]!.userId, timezone: 'Mars/Olympus', weekly: {} }),
  )
  check('a timezone that does not exist is refused', badZone)

  // -----------------------------------------------------------------------
  section('extremes')

  const longName = 'Ǆ'.repeat(500)
  const longBooking = await confirmBooking(
    datasaur,
    {
      page,
      startsAt: new Date('2026-09-18T17:00:00.000Z'),
      body: { name: longName, email: 'long@race-booking.test' },
      attendeeTimezone: 'Pacific/Chatham',
      attribution: {},
    },
    soleHost,
    fakeProvisioner,
  )
  check(
    'a 500 character name and a 45 minute offset zone both survive a booking',
    !!longBooking.bookingId,
    'Pacific/Chatham is +12:45',
  )

  const wideWindow = computeSlots({
    ...laHost,
    from: new Date('2026-09-01T00:00:00Z'),
    to: new Date('2027-09-01T00:00:00Z'),
    maxHorizonDays: 365,
    now: new Date('2026-09-01T00:00:00Z'),
  })
  check(
    'a whole year of availability is computed without falling over',
    wideWindow.length > 4000,
    `${wideWindow.length} slots`,
  )
} catch (cause) {
  failures++
  console.error('\nthe suite could not finish:', cause instanceof Error ? cause.stack : cause)
} finally {
  console.log(
    failures === 0
      ? `\nall ${checks} booking checks passed.`
      : `\n${failures} of ${checks} booking checks FAILED.`,
  )
  // Given back before exiting, so the next suite in `pnpm verify` does not start
  // against a pooler this one is still holding connections on.
  await closeAppPool()
  process.exit(failures === 0 ? 0 : 1)
}

async function bySlug(ctx: WorkspaceContext, slug: string): Promise<BookingPageConfig> {
  const rows = await scoped<{ id: string }>(ctx, sql`select id from booking_page where slug = ${slug}`)
  const id = rows[0]?.id
  if (!id) throw new Error(`booking page ${slug} is not seeded. Run pnpm db:seed.`)
  const page = await readBookingPage(ctx, id)
  if (!page) throw new Error(`booking page ${slug} could not be read.`)
  return page
}

async function refusesAsync(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}
