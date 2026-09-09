import { and, eq, inArray, notLike, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { channelOfSession, readAttribution, sourceFrom } from '../src/dal/attribution.ts'
import { SPAM_WEIGHTS } from '../src/dal/spam.ts'
import { provisionAccount } from '../src/dal/provision.ts'
import { SEED_FORMS } from '../src/registry/forms.ts'
import * as s from '../src/schema/index.ts'
import { SANDBOX, PEER } from './fixture.ts'

/** Roughly 20 of each, covering every state the UI has to survive: empty, one, a
 *  500-character name, missing owner, missing company, zero amount. Production-scale
 *  load testing lives in feature 07 with the importer that needs it. D9.
 *
 *  Two accounts, always. The second one exists so the cross-tenant test has
 *  something real to fail against. */

const url = process.env.DATABASE_URL_OWNER
if (!url) throw new Error('DATABASE_URL_OWNER is not set.')

const client = postgres(url, { max: 1, onnotice: () => {} })
const db = drizzle(client, { schema: s })

/** Two accounts, which is HubSpot's answer for two companies that share nothing:
 *  separate portals. The second exists so the cross-tenant tests have something
 *  real to fail against. */
const ACCOUNTS = [
  { ...SANDBOX, seatLimit: 25 },
  { ...PEER, seatLimit: null },
] as const

/** One seat per shape of access, named for the shape. A real person signs in with
 *  Google, lands reading whatever the account opens by default, and is raised from
 *  Settings, so nobody's name is seeded.
 *
 *  The names are the old role names on purpose: the dev sign-in form takes an
 *  address, and `sales@` is still the seat that can work deals. */
const PEOPLE = [
  {
    email: 'admin@sandbox.test',
    name: 'Admin',
    isSuperAdmin: true,
    editHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'] as const,
    viewHubs: [] as const,
  },
  {
    email: 'sales@sandbox.test',
    name: 'Sales',
    isSuperAdmin: false,
    editHubs: ['contacts', 'sales'] as const,
    viewHubs: ['reports'] as const,
  },
  {
    email: 'marketing@sandbox.test',
    name: 'Marketing',
    isSuperAdmin: false,
    editHubs: ['contacts', 'marketing'] as const,
    viewHubs: ['reports'] as const,
  },
  {
    email: 'viewer@sandbox.test',
    name: 'Viewer',
    isSuperAdmin: false,
    editHubs: [] as const,
    viewHubs: ['contacts', 'sales', 'marketing', 'reports'] as const,
  },
]

const INDUSTRIES = ['Software', 'Financial Services', 'Healthcare', 'Government', 'Education']
const COUNTRIES = ['United States', 'Indonesia', 'Singapore', 'United Kingdom', 'Germany']
const LONG_NAME = 'Ludwigshafen Interkontinentale Datenverarbeitungsgesellschaft '.repeat(9).slice(0, 500)

/** One of each channel worth having in a report, in the shape a real arrival has. */
const SEED_SOURCES = [
  { rawQuery: '?gclid=seed', referrer: 'https://www.google.com/', landingPage: 'https://datasaur.ai/pricing' },
  { referrer: 'https://www.google.com/', landingPage: 'https://datasaur.ai/' },
  { referrer: 'https://www.linkedin.com/feed/', landingPage: 'https://datasaur.ai/blog' },
  { rawQuery: '?utm_source=newsletter&utm_medium=email&utm_campaign=march', landingPage: 'https://datasaur.ai/' },
  { referrer: 'https://news.ycombinator.com/', landingPage: 'https://datasaur.ai/' },
  { landingPage: 'https://datasaur.ai/' },
]

const dayAgo = (n: number) => new Date(Date.UTC(2026, 7, 23) - n * 86_400_000)

try {
  // Idempotent: the whole account goes, cascades take every record in it.
  const existing = await db
    .select({ id: s.account.id, slug: s.account.slug })
    .from(s.account)
    .where(inArray(s.account.slug, ACCOUNTS.map((a) => a.slug)))

  // A cascade from `account` is total, and it once took a live Gmail mailbox with
  // it. The fixture slugs are on reserved `.test` domains precisely so nothing
  // real can hold one, but the check is here rather than in the naming: a seat
  // whose sub came from Google is somebody who actually signed in, and no
  // fixture ever has one.
  for (const account of existing) {
    const [real] = await db
      .select({ email: s.userAccount.email })
      .from(s.membership)
      .innerJoin(s.userAccount, eq(s.userAccount.id, s.membership.userId))
      .where(and(eq(s.membership.accountId, account.id), notLike(s.userAccount.googleSub, 'dev:%')))
      .limit(1)
    if (real) {
      throw new Error(
        `Account ${account.slug} seats ${real.email}, who signed in with Google. ` +
          'Seeding would delete the account and everything in it. Move the fixtures to another slug, or remove that seat first.',
      )
    }
  }

  if (existing.length) {
    await db.delete(s.account).where(inArray(s.account.id, existing.map((a) => a.id)))
  }

  const accounts = await db
    .insert(s.account)
    .values(
      ACCOUNTS.map((a) => ({
        name: a.name,
        slug: a.slug,
        googleHostedDomain: a.domain,
        seatLimit: a.seatLimit,
        defaultViewHubs: ['contacts', 'sales', 'marketing', 'reports'] as ('contacts' | 'sales' | 'marketing' | 'reports')[],
      })),
    )
    .returning({ id: s.account.id, slug: s.account.slug })

  const wsId = (slug: string) => {
    const found = accounts.find((a) => a.slug === slug)
    if (!found) throw new Error(`account ${slug} was not created`)
    return found.id
  }
  const sandbox = wsId(SANDBOX.slug)
  const peer = wsId(PEER.slug)

  const users = await db
    .insert(s.userAccount)
    .values([
      ...PEOPLE.map((p) => ({ email: p.email, name: p.name, googleSub: `dev:${p.email}` })),
      { email: 'admin@peer.test', name: 'Peer Admin', googleSub: 'dev:admin@peer.test' },
      // Somebody whose access was ended. The row stays so the audit trail still
      // names them, and every membership they hold stops answering.
      { email: 'former@sandbox.test', name: 'Former', googleSub: 'dev:former@sandbox.test' },
    ])
    .onConflictDoUpdate({ target: s.userAccount.email, set: { name: sql`excluded.name` } })
    .returning({ id: s.userAccount.id, email: s.userAccount.email })

  const userId = (email: string) => {
    const found = users.find((u) => u.email === email)
    if (!found) throw new Error(`user ${email} was not created`)
    return found.id
  }

  await db.insert(s.membership).values([
    ...PEOPLE.map((p) => ({
      accountId: sandbox,
      userId: userId(p.email),
      isSuperAdmin: p.isSuperAdmin,
      editHubs: [...p.editHubs],
      viewHubs: [...p.viewHubs],
    })),
    {
      accountId: peer,
      userId: userId('admin@peer.test'),
      isSuperAdmin: true,
      editHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'],
    },
    // Somebody whose access was ended. The row stays so the audit trail still
    // names them, and their membership stops answering.
    {
      accountId: sandbox,
      userId: userId('former@sandbox.test'),
      editHubs: ['contacts', 'sales'],
      state: 'deactivated' as const,
      deactivatedAt: dayAgo(3),
      deactivatedBy: userId('admin@sandbox.test'),
    },
  ])

  // One seat offered and not yet claimed, so the pending tab is never empty in
  // development. The hash is of a token nobody holds; the link cannot be used.
  await db.insert(s.invitation).values({
    accountId: sandbox,
    email: 'newstarter@sandbox.test',
    editHubs: ['contacts', 'sales'],
    tokenHash: 'seed-invitation-hash-not-a-usable-token',
    invitedBy: userId('admin@sandbox.test'),
    expiresAt: new Date(Date.UTC(2026, 8, 30)),
  })

  const [salesTeam] = await db
    .insert(s.team)
    .values({ accountId: sandbox, name: 'Sales EMEA', description: 'Works European inbound.' })
    .returning({ id: s.team.id })
  if (!salesTeam) throw new Error('the team was not created')
  await db.insert(s.teamMember).values([
    { accountId: sandbox, teamId: salesTeam.id, userId: userId('sales@sandbox.test'), isLead: true },
    { accountId: sandbox, teamId: salesTeam.id, userId: userId('marketing@sandbox.test') },
  ])

  const owners = PEOPLE.filter((p) => p.editHubs.length > 0).map((p) => userId(p.email))

  for (const ws of [sandbox, peer]) {
    // The same provisioning a real account gets on its first sign-in, so a seeded
    // account and a real one cannot differ.
    await provisionAccount(db as unknown as Parameters<typeof provisionAccount>[0], ws)

    const stages = await db
      .select({ id: s.lifecycleStage.id, name: s.lifecycleStage.name })
      .from(s.lifecycleStage)
      .where(eq(s.lifecycleStage.accountId, ws))
      .orderBy(s.lifecycleStage.position)

    const enterpriseStages = await db
      .select({ id: s.pipelineStage.id, name: s.pipelineStage.name, pipelineId: s.pipelineStage.pipelineId })
      .from(s.pipelineStage)
      .innerJoin(s.pipeline, eq(s.pipeline.id, s.pipelineStage.pipelineId))
      .where(and(eq(s.pipelineStage.accountId, ws), eq(s.pipeline.name, 'Enterprise')))
      .orderBy(s.pipelineStage.position)
    const enterpriseId = enterpriseStages[0]?.pipelineId
    if (!enterpriseId) throw new Error('the Enterprise pipeline was not provisioned')

    // The peer tenant gets one record of each, which is also the "exactly one row"
    // case every list has to render correctly.
    const scale = ws === sandbox ? 20 : 1
    const ownerFor = (i: number) => (ws === sandbox ? (owners[i % owners.length] ?? null) : null)

    const companies = await db
      .insert(s.company)
      .values(
        Array.from({ length: scale }, (_, i) => ({
          accountId: ws,
          // Row 4 has no name at all: HubSpot holds many blank company names and
          // every surface has to survive them.
          name: i === 4 ? null : i === 7 ? LONG_NAME : `${INDUSTRIES[i % 5]} Partner ${i + 1}`,
          domain: i === 5 ? null : `partner${i + 1}.example`,
          industry: INDUSTRIES[i % INDUSTRIES.length]!,
          city: i === 6 ? null : 'Jakarta',
          country: COUNTRIES[i % COUNTRIES.length]!,
          employeeCount: i === 3 ? null : (i + 1) * 25,
          annualRevenue: i === 3 ? null : String((i + 1) * 250_000),
          ownerId: ownerFor(i),
          lifecycleStageId: stages[i % stages.length]?.id ?? null,
          createdAt: dayAgo(scale - i),
          originalSource: { channel: 'organic_search', raw_query: '', referrer: null },
        })),
      )
      .returning({ id: s.company.id })

    await db.insert(s.contact).values(
      Array.from({ length: scale }, (_, i) => ({
        accountId: ws,
        firstName: i === 2 ? null : `Contact${i + 1}`,
        lastName: i === 2 ? null : `Surname${i + 1}`,
        // Row 3 is on a free provider, so A4's rule has a case in the seed data.
        email: i === 9 ? null : i === 3 ? `contact4@gmail.com` : `contact${i + 1}@partner${i + 1}.example`,
        phone: i % 3 === 0 ? null : `+62 21 5555 ${1000 + i}`,
        title: i === 8 ? LONG_NAME : 'Head of Data',
        linkedinUrl: i % 4 === 0 ? null : `https://www.linkedin.com/in/contact${i + 1}`,
        // Row 1 has no company: an unlinked contact is normal, not an error.
        companyId: i === 1 || i === 3 ? null : (companies[i % companies.length]?.id ?? null),
        ownerId: ownerFor(i),
        lifecycleStageId: stages[i % stages.length]?.id ?? null,
        leadStatus: i % 2 === 0 ? 'New' : 'Open',
        marketingStatus: i % 5 === 0 ? 'Non-marketing contact' : 'Marketing contact',
        createdAt: dayAgo(scale - i),
        // Built through the same helper a real capture uses, so seeded contacts
        // carry the shape and the vocabulary the attribution report groups by
        // rather than a hand-written approximation of it. A spread of channels,
        // because a report where every contact came from one place shows nothing.
        originalSource: sourceFrom(readAttribution(SEED_SOURCES[i % SEED_SOURCES.length]!)),
      })),
    )

    const contacts = await db
      .select({ id: s.contact.id })
      .from(s.contact)
      .where(eq(s.contact.accountId, ws))

    const deals = await db
      .insert(s.deal)
      .values(
        Array.from({ length: scale }, (_, i) => ({
          accountId: ws,
          name: i === 6 ? null : `${INDUSTRIES[i % 5]} rollout ${i + 1}`,
          pipelineId: enterpriseId,
          stageId: enterpriseStages[i % enterpriseStages.length]!.id,
          // Zero and null amounts both exist in the real portal.
          amount: i === 0 ? '0' : i === 11 ? null : String((i + 1) * 25_000),
          currency: 'USD',
          closeDate: i === 12 ? null : dayAgo(-(i + 5)).toISOString().slice(0, 10),
          nextStep: i % 3 === 0 ? null : 'Send revised pricing',
          // Rows 2 and 5 are already overdue, which is the Monday list.
          nextStepDate:
            i % 3 === 0 ? null : dayAgo(i === 2 || i === 5 ? 6 : -(i + 2)).toISOString().slice(0, 10),
          ownerId: ownerFor(i),
          companyId: companies[i % companies.length]?.id ?? null,
          dealType: i % 2 === 0 ? 'New Business' : 'Existing Business',
          custom: {
            uttr_pipeline: i % 4 === 0,
            deal_product_of_interest: i % 3 === 0 ? ['NLP Labeling'] : ['LLM Labs', 'Data Studio'],
          },
          createdAt: dayAgo(scale - i),
        })),
      )
      .returning({ id: s.deal.id, name: s.deal.name })

    // Deal to contact association, so the right rail and the merge path both have
    // rows to work with rather than an empty table.
    await db.insert(s.association).values(
      deals.flatMap((deal, i) => {
        const contact = contacts[i % Math.max(contacts.length, 1)]
        return contact ? [{ accountId: ws, fromType: 'contact' as const, fromId: contact.id, toType: 'deal' as const, toId: deal.id, label: 'Decision maker' }] : []
      }),
    )

    // A timeline with something on it. One deal gets 120 entries so the keyset
    // pagination and the per-type counts are exercised, not just rendered.
    const busy = deals[0]
    if (busy) {
      const entries = Array.from({ length: 120 }, (_, i) => ({
        accountId: ws,
        type: (['note', 'call', 'email', 'meeting', 'stage_change'] as const)[i % 5]!,
        subject: `Touchpoint ${i + 1} on ${busy.name ?? 'the deal'}`,
        body: i % 5 === 0 ? 'Talked through the trial plan and the security review.' : null,
        occurredAt: dayAgo(i),
        actorId: owners[i % owners.length] ?? null,
        actorKind: 'user' as const,
        source: 'seed',
      }))
      const written = await db.insert(s.activity).values(entries).returning({ id: s.activity.id })
      await db.insert(s.activityLink).values(
        written.map((row, i) => ({
          accountId: ws,
          activityId: row.id,
          entityType: 'deal' as const,
          entityId: busy.id,
          type: entries[i]!.type,
          occurredAt: entries[i]!.occurredAt,
        })),
      )
    }

    await db.insert(s.task).values(
      deals.slice(0, Math.min(4, deals.length)).map((deal, i) => ({
        accountId: ws,
        title: `Chase ${deal.name ?? 'the unnamed deal'}`,
        dueDate: dayAgo(i === 0 ? 3 : -(i + 1)).toISOString().slice(0, 10),
        assigneeId: owners[i % owners.length] ?? null,
        entityType: 'deal' as const,
        entityId: deal.id,
        createdBy: owners[0] ?? null,
      })),
    )

    // Most contacts have never said anything, which must render as exactly that.
    // Two have, so both other states are on screen somewhere. D15.
    const subTypes = await db
      .select({ id: s.subscriptionType.id, name: s.subscriptionType.name })
      .from(s.subscriptionType)
      .where(eq(s.subscriptionType.accountId, ws))
    const newsletter = subTypes.find((t) => t.name === 'Newsletter')
    if (newsletter && contacts.length > 1) {
      await db.insert(s.subscriptionState).values([
        { accountId: ws, contactId: contacts[0]!.id, subscriptionTypeId: newsletter.id, state: 'subscribed' as const, source: 'seed' },
        { accountId: ws, contactId: contacts[1]!.id, subscriptionTypeId: newsletter.id, state: 'unsubscribed' as const, source: 'seed' },
      ])
    }
  }

  // F3. Every account gets the same starting forms, including the peer tenant,
  // so the cross-tenant test has a form on both sides to prove isolation with.
  for (const ws of [sandbox, peer]) {
    await db.insert(s.form).values(
      SEED_FORMS.map((form) => ({
        accountId: ws,
        name: form.name,
        slug: form.slug,
        schema: form.fields,
        settings: form.settings,
        isActive: true,
      })),
    )
  }

  // F4. One site per tenant. Nothing is collected until one exists, so the
  // collector tests and the local embed both need this row to be here.
  await db.insert(s.site).values([
    { accountId: sandbox, name: 'Marketing site', host: 'datasaur.ai', siteKey: 'sandbox-www' },
    { accountId: peer, name: 'Probe site', host: 'probe.example', siteKey: 'peer-www' },
  ])

  // F4 and B7. Traffic, so the website and attribution reports have something to
  // report on and the visit history on a contact has something to show. Without
  // these rows four screens render their empty state on a seeded database, which
  // makes them impossible to judge and easy to break unnoticed.
  {
    const [site] = await db
      .select({ id: s.site.id })
      .from(s.site)
      .where(eq(s.site.accountId, sandbox))
    const seen = await db
      .select({ id: s.contact.id, email: s.contact.email, firstName: s.contact.firstName })
      .from(s.contact)
      .where(eq(s.contact.accountId, sandbox))

    const PATHS = ['/', '/pricing', '/blog', '/product/data-studio', '/contact']
    const DEVICES = ['desktop', 'mobile', 'tablet']

    // Every third visit is somebody Rawr can name, which is roughly what a real
    // site sees and is what makes "identified share" a number rather than 0 or 100.
    const sessions = Array.from({ length: 48 }, (_, i) => {
      const source = SEED_SOURCES[i % SEED_SOURCES.length]!
      const startedAt = dayAgo(45 - Math.floor(i * 0.9))
      const contact = i % 3 === 0 ? (seen[i % seen.length] ?? null) : null
      const utm = Object.fromEntries(new URLSearchParams(source.rawQuery ?? ''))
      return {
        visitorId: `seed-visitor-${i}`,
        contact,
        utm,
        startedAt,
        referrer: source.referrer ?? null,
        landingPage: source.landingPage ?? 'https://datasaur.ai/',
        pages: 1 + (i % 4),
      }
    })

    // The visitor row is what the reports join to answer "how much of this
    // traffic can Rawr put a name to", so a session without one is anonymous
    // however many aliases point at it.
    await db.insert(s.visitor).values(
      sessions.map((session) => ({
        accountId: sandbox,
        id: session.visitorId,
        contactId: session.contact?.id ?? null,
        firstReferrer: session.referrer,
        firstLandingPage: session.landingPage,
        sessionCount: 1,
        firstSeenAt: session.startedAt,
        lastSeenAt: session.startedAt,
      })),
    )

    const written = await db
      .insert(s.visitorSession)
      .values(
        sessions.map((session) => ({
          accountId: sandbox,
          visitorId: session.visitorId,
          siteId: site?.id ?? null,
          startedAt: session.startedAt,
          endedAt: new Date(session.startedAt.getTime() + session.pages * 90_000),
          entryPath: new URL(session.landingPage).pathname,
          exitPath: PATHS[session.pages % PATHS.length]!,
          pageCount: session.pages,
          referrer: session.referrer,
          utm: session.utm,
          // Derived by the same helper the collector uses, so the seed cannot
          // hold a channel no capture path would ever produce.
          channel: channelOfSession({ referrer: session.referrer, utm: session.utm }),
        })),
      )
      .returning({ id: s.visitorSession.id, visitorId: s.visitorSession.visitorId })

    const idOf = new Map(written.map((row) => [row.visitorId, row.id]))
    await db.insert(s.pageView).values(
      sessions.flatMap((session) =>
        Array.from({ length: session.pages }, (_, page) => ({
          accountId: sandbox,
          visitorId: session.visitorId,
          contactId: session.contact?.id ?? null,
          sessionId: idOf.get(session.visitorId) ?? null,
          siteId: site?.id ?? null,
          url: `https://datasaur.ai${PATHS[(page + session.pages) % PATHS.length]}`,
          path: PATHS[(page + session.pages) % PATHS.length]!,
          title: 'Datasaur',
          referrer: page === 0 ? session.referrer : null,
          utm: session.utm,
          device: DEVICES[session.pages % DEVICES.length]!,
          country: COUNTRIES[session.pages % COUNTRIES.length]!,
          at: new Date(session.startedAt.getTime() + page * 60_000),
        })),
      ),
    )

    const identified = sessions.filter((session) => session.contact !== null)
    if (identified.length > 0) {
      await db
        .insert(s.visitorAlias)
        .values(
          identified.map((session) => ({
            accountId: sandbox,
            visitorId: session.visitorId,
            contactId: session.contact!.id,
            via: 'form_submission' as const,
            createdAt: session.startedAt,
            resolvedAt: session.startedAt,
          })),
        )
        .onConflictDoNothing()
    }

    // F3. Submissions, including two the spam rules held, so the review queue is
    // not an empty screen and the forms report has a clean-versus-held split.
    const forms = await db
      .select({ id: s.form.id, slug: s.form.slug })
      .from(s.form)
      .where(eq(s.form.accountId, sandbox))
    if (forms.length > 0) {
      await db.insert(s.formSubmission).values(
        identified.slice(0, 14).map((session, i) => {
          const held = i === 3 || i === 9
          const form = forms[i % forms.length]!
          return {
            accountId: sandbox,
            formId: form.id,
            values: {
              email: session.contact!.email ?? `seed${i}@partner${i}.example`,
              first_name: session.contact!.firstName ?? `Contact${i + 1}`,
              message: held ? 'CHEAP BACKLINKS http://spam.example' : 'We would like a demo.',
            },
            attribution: readAttribution({
              referrer: session.referrer,
              rawQuery: new URLSearchParams(session.utm).toString(),
              landingPage: session.landingPage,
              firstSeenAt: session.startedAt,
            }),
            contactId: held ? null : session.contact!.id,
            visitorId: session.visitorId,
            spamScore: held ? SPAM_WEIGHTS.tooManyLinks + SPAM_WEIGHTS.disposableDomain : 0,
            spamState: held ? ('quarantined' as const) : ('clean' as const),
            // The scorer's own shape, so the review queue renders a reason a
            // person can read rather than a bullet with nothing after it.
            spamReasons: held
              ? [
                  { rule: 'tooManyLinks', points: SPAM_WEIGHTS.tooManyLinks, detail: '2 links in one short message' },
                  { rule: 'disposableDomain', points: SPAM_WEIGHTS.disposableDomain, detail: 'spam.example is a throwaway domain' },
                ]
              : [],
            at: session.startedAt,
          }
        }),
      )
    }
  }

  // F2. A round robin across the three non-viewer staff plus a personal link for
  // one of them, on both tenants so the isolation test has a page on each side.
  // Availability is nine to five in three different zones on purpose: a bug that
  // only shows up across timezones has to be visible in the seed.
  const BOOKING_ZONES = ['America/Los_Angeles', 'Asia/Jakarta', 'Europe/Berlin']

  for (const ws of [sandbox, peer]) {
    const staff =
      ws === sandbox
        ? PEOPLE.filter((p) => p.editHubs.length > 0).map((p) => userId(p.email))
        : [userId('admin@peer.test')]

    await db.insert(s.availability).values(
      staff.map((id, i) => ({
        accountId: ws,
        userId: id,
        timezone: BOOKING_ZONES[i % BOOKING_ZONES.length]!,
        weekly: {
          '1': [['09:00', '17:00']],
          '2': [['09:00', '17:00']],
          '3': [['09:00', '17:00']],
          '4': [['09:00', '17:00']],
          '5': [['09:00', '13:00']],
        },
      })),
    )

    // The development provider: Rawr's own confirmed bookings are the only source
    // of busy time. It is what makes the engine exercisable while no Google project is
    // outstanding, and the web layer refuses it outside development.
    await db.insert(s.calendarGrant).values(
      staff.map((id) => ({
        accountId: ws,
        userId: id,
        provider: 'dev' as const,
        calendarId: 'primary',
        state: 'connected' as const,
        lastOkAt: new Date(),
      })),
    )

    const [roundRobin] = await db
      .insert(s.bookingPage)
      .values({
        accountId: ws,
        slug: 'sales-team',
        name: 'Talk to sales',
        kind: 'round_robin',
        durationMinutes: 30,
        bufferAfterMinutes: 15,
        minNoticeMinutes: 240,
        maxHorizonDays: 60,
        granularityMinutes: 30,
        location: 'zoom',
        titleTpl: 'Discovery Session with Datasaur <> {{company.name}}',
        descriptionTpl:
          '{{contact.first_name}} {{contact.last_name}} {{contact.email}}\n{{company.name}}',
        companyFallback: 'a new team',
        questions: [
          {
            key: 'interest',
            type: 'select',
            label: 'What are you looking at?',
            required: false,
            options: [
              { value: 'labeling', label: 'Data labeling' },
              { value: 'llm', label: 'LLM evaluation' },
              { value: 'other', label: 'Something else' },
            ],
          },
        ],
        isActive: true,
      })
      .returning({ id: s.bookingPage.id })

    if (!roundRobin) throw new Error('booking_page sales-team was not created')

    await db.insert(s.bookingHost).values(
      staff.map((id, i) => ({
        accountId: ws,
        bookingPageId: roundRobin.id,
        userId: id,
        // Uneven on purpose: an even split hides a weighting bug.
        weight: i === 0 ? 2 : 1,
      })),
    )

    // F2. A collective, so the intersection path has something real to exercise:
    // two people who both have to be free, and one who is invited when they are.
    const [panel] = await db
      .insert(s.bookingPage)
      .values({
        accountId: ws,
        slug: 'solution-review',
        name: 'Solution review',
        kind: 'collective',
        durationMinutes: 60,
        bufferAfterMinutes: 15,
        minNoticeMinutes: 1440,
        maxHorizonDays: 45,
        granularityMinutes: 60,
        location: 'google_meet',
        titleTpl: 'Solution review · Datasaur <> {{company.name}}',
        descriptionTpl: '{{contact.full_name}} · {{contact.email}}\n{{company.name}}',
        companyFallback: 'a new team',
        questions: [],
        isActive: true,
      })
      .returning({ id: s.bookingPage.id })

    if (!panel) throw new Error('booking_page solution-review was not created')

    await db.insert(s.bookingHost).values(
      staff.map((id, i) => ({
        accountId: ws,
        bookingPageId: panel.id,
        userId: id,
        weight: 1,
        // The Jakarta and Berlin hours overlap for three hours a day and the Los
        // Angeles ones overlap with neither, so requiring the first two leaves a
        // page that can actually be booked and makes the third genuinely optional.
        // A collective whose required hosts never overlap offers nothing, which is
        // correct and useless to look at.
        isRequired: i > 0,
      })),
    )

    const owner = staff[0]!
    const [personal] = await db
      .insert(s.bookingPage)
      .values({
        accountId: ws,
        slug: 'one-on-one',
        name: 'Book time with me',
        kind: 'one_on_one',
        ownerId: owner,
        durationMinutes: 45,
        granularityMinutes: 15,
        minNoticeMinutes: 60,
        location: 'google_meet',
        titleTpl: '{{host.name}} <> {{company.name}}',
        descriptionTpl: '{{contact.full_name}} · {{contact.email}}',
        companyFallback: 'you',
        questions: [],
        isActive: true,
      })
      .returning({ id: s.bookingPage.id })

    if (!personal) throw new Error('booking_page one-on-one was not created')
    await db
      .insert(s.bookingHost)
      .values({ accountId: ws, bookingPageId: personal.id, userId: owner, weight: 1 })

    // F2. Meetings on the books, two ahead and two behind, so the booked list is
    // not an empty screen on a seeded database and the upcoming and past tabs
    // both have something to show.
    if (ws === sandbox) {
      const booked = await db
        .select({ id: s.contact.id, email: s.contact.email, firstName: s.contact.firstName })
        .from(s.contact)
        .where(eq(s.contact.accountId, ws))
        .limit(4)
      await db.insert(s.booking).values(
        booked.map((contact, i) => {
          // Relative to the real clock rather than to the seed's own anchor,
          // because "upcoming" has to still be upcoming whenever the seed is run.
          const day = new Date()
          // Half past, and not on the hour: verify-booking pins a slot at an
          // absolute instant on the hour, and a seeded meeting landing on it
          // makes a host busy that the suite expects to be free.
          day.setUTCHours(15, 30, 0, 0)
          const startsAt = new Date(day.getTime() + (i < 2 ? 3 + i * 4 : -(4 + i * 3)) * 86_400_000)
          return {
            accountId: ws,
            bookingPageId: i % 2 === 0 ? roundRobin.id : personal.id,
            hostUserId: staff[i % staff.length]!,
            contactId: contact.id,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 30 * 60_000),
            attendeeTimezone: BOOKING_ZONES[i % BOOKING_ZONES.length]!,
            attendeeName: `${contact.firstName ?? 'Someone'} Surname${i + 1}`,
            attendeeEmail: contact.email ?? `booked${i}@partner${i}.example`,
            answers: { notes: 'Looking at Data Studio for the research team.' },
            state: i === 3 ? ('cancelled' as const) : ('confirmed' as const),
            cancelledAt: i === 3 ? dayAgo(2) : null,
            cancelReason: i === 3 ? 'Something came up.' : null,
            // Padded: bookingForToken refuses anything under twenty characters
            // before it looks, because a real token is long and random, and a
            // short seeded one made every manage link read as expired.
            cancelToken: `seed-cancel-${i}`.padEnd(28, '0'),
            rescheduleToken: `seed-reschedule-${i}`.padEnd(28, '0'),
            conferenceUrl: 'https://meet.google.com/seed-demo',
          }
        }),
      )
    }
  }

  const counts = await client`
    select 'company' as t, count(*)::int as n from company
    union all select 'contact', count(*)::int from contact
    union all select 'deal', count(*)::int from deal
    union all select 'field_def', count(*)::int from field_def
    union all select 'pipeline_stage', count(*)::int from pipeline_stage
    union all select 'saved_view', count(*)::int from saved_view
    union all select 'activity', count(*)::int from activity
    union all select 'task', count(*)::int from task
    union all select 'association', count(*)::int from association
    union all select 'form', count(*)::int from form
    union all select 'form_submission', count(*)::int from form_submission
    union all select 'visitor_session', count(*)::int from visitor_session
    union all select 'page_view', count(*)::int from page_view
    union all select 'booking_page', count(*)::int from booking_page
    union all select 'booking', count(*)::int from booking
    union all select 'booking_host', count(*)::int from booking_host
    union all select 'availability', count(*)::int from availability
    union all select 'integration', count(*)::int from integration
    order by t`
  console.log('seeded:')
  for (const row of counts) console.log(`  ${row.t}: ${row.n}`)
  console.log('\ndev sign-in emails: ' + PEOPLE.map((p) => p.email).join(', '))
} finally {
  await client.end()
}
