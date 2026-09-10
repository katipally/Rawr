import { and, eq, inArray, notLike, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { channelOfSession, readAttribution, sourceFrom } from '../src/dal/attribution.ts'
import { SPAM_WEIGHTS } from '../src/dal/spam.ts'
import { provisionAccount } from '../src/dal/provision.ts'
import { DEFAULT_SETTINGS } from '../src/dal/form-schema.ts'
import { encryptToken } from '../src/internal/crypto.ts'
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

/** Provider secrets are encrypted with a key held outside this database, so a dump
 *  of it is not a set of live credentials. Without the key the seed still builds
 *  every row and leaves the secret out, which is the state a fresh checkout is in
 *  and which every screen already has to survive. */
const encrypting = Boolean(process.env.TOKEN_ENCRYPTION_KEY)
if (!encrypting) {
  console.log('TOKEN_ENCRYPTION_KEY is not set: mailbox and app credentials are seeded without a secret.')
}
const NO_SECRET = 'seed-placeholder-not-encrypted'
const secret = (plaintext: string): string => (encrypting ? encryptToken(plaintext) : NO_SECRET)

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

  // F2. The half of the product the seed never reached: sequences, templates,
  // automations, imports, a dashboard, segments, a mailbox with correspondence on
  // it, notifications, files, an invented object and three connected apps.
  //
  // Sandbox only. The peer tenant exists so a cross-tenant check has something
  // real to fail against, and the rows above already give it that.
  {
    const contacts = await db
      .select({ id: s.contact.id, email: s.contact.email, firstName: s.contact.firstName })
      .from(s.contact)
      .where(eq(s.contact.accountId, sandbox))
      .orderBy(s.contact.createdAt)
    const deals = await db
      .select({ id: s.deal.id, name: s.deal.name })
      .from(s.deal)
      .where(eq(s.deal.accountId, sandbox))
      .orderBy(s.deal.createdAt)
    const objects = await db
      .select({ id: s.objectDef.id, key: s.objectDef.key })
      .from(s.objectDef)
      .where(eq(s.objectDef.accountId, sandbox))
    const objectId = (key: string) => {
      const found = objects.find((o) => o.key === key)
      if (!found) throw new Error(`object_def ${key} was not provisioned`)
      return found.id
    }
    const adminId = userId('admin@sandbox.test')
    const salesId = userId('sales@sandbox.test')
    const marketingId = userId('marketing@sandbox.test')
    const emailed = contacts.filter((c) => c.email !== null)
    if (emailed.length < 6) throw new Error('the seed needs six contacts with an address')

    // Marketing's rather than sales': verify-mail and verify-sequences both take
    // over the sales mailbox and verify-mail disconnects it, which would leave the
    // enrollments below pointing at nothing.
    //
    // Nothing here can send: the mailbox holds a placeholder where a Google grant
    // would be, and RAWR_DEV_GMAIL is what makes the sync exercisable without one.
    const [box] = await db
      .insert(s.mailbox)
      .values({
        accountId: sandbox,
        userId: marketingId,
        email: 'marketing@sandbox.test',
        state: 'connected' as const,
        visibility: 'team' as const,
        accessToken: secret('dev-access-token'),
        refreshToken: secret('dev-refresh-token'),
        accessTokenExpiresAt: dayAgo(-1),
        historyId: '1',
        backfillDone: true,
        lastSyncAt: dayAgo(0),
        canSend: true,
      })
      .returning({ id: s.mailbox.id })
    if (!box) throw new Error('the mailbox was not created')

    // Twenty conversations, so the inbox pages and the record timeline has mail on
    // it. Half inbound, so "who spoke last" is not the same answer everywhere.
    const threads = await db
      .insert(s.messageThread)
      .values(
        Array.from({ length: 20 }, (_, i) => ({
          accountId: sandbox,
          providerThreadId: `seed-thread-${i + 1}`,
          subject: i === 4 ? null : `${['Trial questions', 'Security review', 'Pricing', 'Renewal'][i % 4]} ${i + 1}`,
          firstAt: dayAgo(20 - i),
          lastAt: dayAgo(20 - i),
          messageCount: 1,
        })),
      )
      .returning({ id: s.messageThread.id })

    const messages = await db
      .insert(s.message)
      .values(
        threads.map((thread, i) => {
          const contact = emailed[i % emailed.length]!
          const inbound = i % 2 === 0
          return {
            accountId: sandbox,
            threadId: thread.id,
            providerMessageId: `seed-message-${i + 1}`,
            direction: inbound ? ('inbound' as const) : ('outbound' as const),
            fromAddr: inbound ? contact.email! : 'marketing@sandbox.test',
            toAddrs: inbound ? ['marketing@sandbox.test'] : [contact.email!],
            sentAt: dayAgo(20 - i),
            snippet: 'Only the first line is stored on the message itself.',
            internetMessageId: `<seed-message-${i + 1}@sandbox.test>`,
            bodyState: 'stored' as const,
            mailboxId: box.id,
          }
        }),
      )
      .returning({ id: s.message.id })

    await db.insert(s.messageBody).values(
      messages.map((message, i) => {
        const textBody = `Thanks for the note.\n\nThis is seeded conversation ${i + 1}.`
        return {
          accountId: sandbox,
          messageId: message.id,
          textBody,
          htmlBody: `<p>Thanks for the note.</p><p>This is seeded conversation ${i + 1}.</p>`,
          textBytes: Buffer.byteLength(textBody),
          htmlBytes: 96,
        }
      }),
    )

    await db.insert(s.messageParticipant).values(
      messages.flatMap((message, i) => {
        const contact = emailed[i % emailed.length]!
        const inbound = i % 2 === 0
        return [
          {
            accountId: sandbox,
            messageId: message.id,
            address: inbound ? contact.email! : 'marketing@sandbox.test',
            contactId: inbound ? contact.id : null,
            role: 'from' as const,
          },
          {
            accountId: sandbox,
            messageId: message.id,
            address: inbound ? 'marketing@sandbox.test' : contact.email!,
            contactId: inbound ? null : contact.id,
            role: 'to' as const,
          },
        ]
      }),
    )

    const sendWindow = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timezone: 'Asia/Jakarta' }
    const settings = {
      sendWindow,
      stopOnReply: true,
      stopOnBounce: true,
      stopOnUnsubscribe: true,
      trackOpens: true,
      trackClicks: true,
      subscriptionTypeId: null,
      replyInThread: true,
      woodpeckerCampaignId: null,
    }

    const sequences = await db
      .insert(s.sequence)
      .values([
        {
          accountId: sandbox,
          name: 'Inbound follow-up',
          description: 'Four touches over a fortnight after somebody asks for a demo.',
          state: 'active' as const,
          ownerId: salesId,
          settings,
          createdBy: salesId,
        },
        {
          accountId: sandbox,
          name: 'Renewal nudge',
          description: 'Written, not yet sending.',
          state: 'draft' as const,
          ownerId: salesId,
          settings,
          createdBy: salesId,
        },
      ])
      .returning({ id: s.sequence.id, name: s.sequence.name })

    // The third step is a task rather than a mail, so the waiting_task state below
    // is one an enrollment can actually be in.
    const STEPS = [
      { kind: 'email' as const, delayDays: 0, subject: 'Following up on your demo request' },
      { kind: 'email' as const, delayDays: 3, subject: 'A couple of things you might have missed' },
      { kind: 'task' as const, delayDays: 4, subject: null },
      { kind: 'email' as const, delayDays: 7, subject: 'Closing the loop' },
    ]
    const steps = await db.insert(s.sequenceStep).values(
      sequences.flatMap((sequence) =>
        STEPS.map((step, position) => ({
          accountId: sandbox,
          sequenceId: sequence.id,
          position,
          kind: step.kind,
          delayDays: step.delayDays,
          subject: step.subject,
          bodyHtml: step.kind === 'email' ? '<p>Hello {{first_name|there}},</p><p>Worth a look?</p>' : null,
          bodyText: step.kind === 'email' ? 'Hello {{first_name|there}},\n\nWorth a look?' : null,
          taskTitle: step.kind === 'task' ? 'Call {{full_name}}' : null,
          taskBody: step.kind === 'task' ? 'They have had two mails and not replied.' : null,
        })),
      ),
    ).returning({
      id: s.sequenceStep.id,
      sequenceId: s.sequenceStep.sequenceId,
      position: s.sequenceStep.position,
      kind: s.sequenceStep.kind,
    })

    // Six enrollments, one per state a screen has to render. The live one is due
    // tomorrow rather than now: a seeded enrollment that is already due starts a
    // real send attempt the next time a worker runs.
    const live = sequences[0]!
    const ENROLLMENTS = [
      { state: 'active' as const, currentStep: 1, nextRunAt: dayAgo(-1), stopReason: null },
      { state: 'waiting_task' as const, currentStep: 3, nextRunAt: null, stopReason: null },
      { state: 'replied' as const, currentStep: 2, nextRunAt: null, stopReason: 'They replied on the thread.' },
      { state: 'bounced' as const, currentStep: 1, nextRunAt: null, stopReason: 'The address bounced permanently.' },
      { state: 'unsubscribed' as const, currentStep: 2, nextRunAt: null, stopReason: 'They asked to stop hearing from us.' },
      { state: 'finished' as const, currentStep: STEPS.length - 1, nextRunAt: null, stopReason: null },
    ]
    const enrollments = await db.insert(s.sequenceEnrollment).values(
      ENROLLMENTS.map((enrollment, i) => ({
        accountId: sandbox,
        sequenceId: live.id,
        contactId: emailed[i]!.id,
        mailboxId: box.id,
        enrolledBy: marketingId,
        state: enrollment.state,
        currentStep: enrollment.currentStep,
        nextRunAt: enrollment.nextRunAt,
        lastSentAt: enrollment.currentStep > 0 ? dayAgo(i + 1) : null,
        finishedAt: enrollment.nextRunAt === null ? dayAgo(i) : null,
        stopReason: enrollment.stopReason,
        unsubscribeToken: `seed-unsubscribe-${i}`.padEnd(28, '0'),
        createdAt: dayAgo(i + 5),
      })),
    ).returning({ id: s.sequenceEnrollment.id })

    // A tile that reads "Sent 0 · Replied 1" is a tile nobody can trust. Every
    // enrollment carries the mail its step counter implies: one row per email
    // step it has already passed, newest ending on its own lastSentAt.
    const emailSteps = steps
      .filter((step) => step.sequenceId === live.id && step.kind === 'email')
      .sort((a, b) => a.position - b.position)
    await db.insert(s.sequenceSend).values(
      enrollments.flatMap((enrollment, i) => {
        const state = ENROLLMENTS[i]!.state
        // Ran out of steps means every email went; anything still running has
        // only passed the ones behind its counter.
        const reached = state === 'finished' ? STEPS.length : ENROLLMENTS[i]!.currentStep
        const taken = emailSteps.filter((step) => step.position < reached)
        return taken.map((step, n) => ({
          accountId: sandbox,
          enrollmentId: enrollment.id,
          contactId: emailed[i]!.id,
          stepId: step.id,
          mailboxId: box.id,
          token: `seed-send-${i}-${n}`.padEnd(28, '0'),
          sentAt: dayAgo(i + 1 + (taken.length - 1 - n)),
          state: state === 'bounced' && n === taken.length - 1 ? ('bounced' as const) : ('sent' as const),
          // Somebody who replied had read it; nothing else claims an open it
          // cannot evidence.
          openCount: state === 'replied' ? 1 : 0,
          firstOpenedAt: state === 'replied' ? dayAgo(i + 1) : null,
          lastOpenedAt: state === 'replied' ? dayAgo(i + 1) : null,
        }))
      }),
    )

    await db.insert(s.emailTemplate).values([
      {
        accountId: sandbox,
        name: 'Demo follow-up',
        subject: 'Following up on your demo',
        bodyText: 'Hello {{first_name|there}},\n\nHere are the notes from our call.',
        createdBy: salesId,
      },
      {
        accountId: sandbox,
        name: 'Security review pack',
        subject: 'Our security documentation',
        bodyText: 'Attached is the SOC 2 report and the DPA.',
        createdBy: salesId,
      },
      {
        accountId: sandbox,
        name: 'Renewal reminder',
        subject: 'Your renewal is coming up',
        bodyText: 'Your term ends soon. Shall we talk?',
        createdBy: marketingId,
      },
    ])

    await db.insert(s.automation).values([
      {
        accountId: sandbox,
        name: 'New form fill becomes a lead',
        isActive: true,
        trigger: 'form_submitted' as const,
        triggerConfig: { object: 'contact' },
        conditions: [],
        steps: [{ kind: 'action', type: 'set_lifecycle', config: { stage: 'Lead' } }],
        createdBy: adminId,
      },
      {
        accountId: sandbox,
        name: 'Proposal stage creates a task',
        isActive: true,
        trigger: 'stage_changed' as const,
        triggerConfig: { object: 'deal' },
        conditions: [{ conjunction: 'and', conditions: [{ field: 'amount', operator: 'gte', value: 50000 }] }],
        steps: [
          { kind: 'delay', minutes: 60 },
          { kind: 'action', type: 'create_task', config: { title: 'Send the revised pricing' } },
        ],
        createdBy: adminId,
      },
      // Parked: written, reviewed and deliberately not armed. The list has to say
      // that differently from an active rule that never matches.
      {
        accountId: sandbox,
        name: 'Enterprise leads to the EMEA pool',
        isActive: false,
        trigger: 'record_created' as const,
        triggerConfig: { object: 'contact' },
        conditions: [{ conjunction: 'and', conditions: [{ field: 'country', operator: 'is', value: 'Germany' }] }],
        steps: [{ kind: 'action', type: 'assign_owner', config: { mode: 'round_robin', pool: [salesId] } }],
        createdBy: adminId,
      },
    ])

    const contactObject = objectId('contact')
    const segments = await db
      .insert(s.segment)
      .values([
        {
          accountId: sandbox,
          name: 'Marketing contacts',
          description: 'Everybody who may be mailed.',
          objectId: contactObject,
          query: [
            { conjunction: 'and', conditions: [{ field: 'marketing_status', operator: 'is', value: 'Marketing contact' }] },
          ],
          lastEvaluatedAt: dayAgo(0),
        },
        {
          accountId: sandbox,
          name: 'Unowned contacts',
          description: 'Nobody is working these.',
          objectId: contactObject,
          query: [{ conjunction: 'and', conditions: [{ field: 'owner_id', operator: 'is_empty' }] }],
          lastEvaluatedAt: dayAgo(0),
        },
        // Static: the members are the file's, not a query's, so the evaluator has
        // to leave both of these alone.
        {
          accountId: sandbox,
          name: 'Webinar March attendees',
          description: 'Uploaded from the webinar platform.',
          objectId: contactObject,
          query: [],
          isStatic: true,
        },
        {
          accountId: sandbox,
          name: 'Imported from HubSpot',
          description: 'The first migration batch.',
          objectId: contactObject,
          query: [],
          isStatic: true,
        },
      ])
      .returning({ id: s.segment.id, isStatic: s.segment.isStatic })

    await db.insert(s.segmentMembership).values(
      segments
        .filter((segment) => segment.isStatic)
        .flatMap((segment, list) =>
          contacts.slice(list * 3, list * 3 + 5).map((contact) => ({
            accountId: sandbox,
            segmentId: segment.id,
            entityId: contact.id,
            enteredAt: dayAgo(10),
          })),
        ),
    )

    await db.insert(s.reportDashboard).values({
      accountId: sandbox,
      name: 'Monday morning',
      ownerId: adminId,
      isShared: true,
      cards: ['deals_created', 'deals_won_amount', 'pipeline_funnel', 'form_fills', 'sequence_sent', 'traffic_channels'],
    })

    // Two finished and one still on the mapping screen, which is the state a person
    // lands back on when they close the tab before choosing their columns.
    const HUBSPOT_HEADERS = [
      'First Name',
      'Last Name',
      'Email',
      'Phone Number',
      'Company Name',
      'Lifecycle Stage',
      'Contact owner',
      'Original Source',
    ]
    const importRuns = await db
      .insert(s.importRun)
      .values([
        {
          accountId: sandbox,
          objectType: 'contact' as const,
          importKind: 'records' as const,
          source: 'hubspot',
          filename: 'hubspot-contacts-2026-08-01.csv',
          fileSignature: 'seed-contacts-8',
          headers: HUBSPOT_HEADERS,
          mapping: {
            'First Name': 'contact.first_name',
            'Last Name': 'contact.last_name',
            Email: 'contact.email',
            'Phone Number': 'contact.phone',
            'Company Name': 'company.name',
            'Lifecycle Stage': 'contact.lifecycle_stage_id',
            'Contact owner': 'contact.owner_id',
            'Original Source': null,
          },
          state: 'done' as const,
          totalRows: 1200,
          processedRows: 1200,
          createdCount: 1150,
          updatedCount: 42,
          skippedCount: 5,
          erroredCount: 3,
          errors: [
            { position: 17, message: 'Email is not an address: "n/a"' },
            { position: 402, message: 'Email is not an address: "-"' },
            { position: 998, message: 'Lifecycle Stage "Evangelist" matches no stage here' },
          ],
          unmatchedOwners: ['dana@oldportal.example', 'rob@oldportal.example'],
          createdBy: adminId,
          createdAt: dayAgo(12),
          finishedAt: dayAgo(12),
        },
        {
          accountId: sandbox,
          objectType: 'company' as const,
          importKind: 'records' as const,
          source: 'hubspot',
          filename: 'hubspot-companies-2026-08-01.csv',
          fileSignature: 'seed-companies-4',
          headers: ['Company name', 'Company domain name', 'Industry', 'Country/Region'],
          mapping: {
            'Company name': 'company.name',
            'Company domain name': 'company.domain',
            Industry: 'company.industry',
            'Country/Region': 'company.country',
          },
          state: 'done' as const,
          totalRows: 340,
          processedRows: 340,
          createdCount: 340,
          createdBy: adminId,
          createdAt: dayAgo(11),
          finishedAt: dayAgo(11),
        },
        {
          accountId: sandbox,
          objectType: 'contact' as const,
          importKind: 'records' as const,
          source: 'hubspot',
          filename: 'hubspot-contacts-2026-09-01.csv',
          fileSignature: 'seed-contacts-8',
          headers: HUBSPOT_HEADERS,
          mapping: {},
          state: 'mapping' as const,
          totalRows: 3,
          createdBy: adminId,
          createdAt: dayAgo(1),
        },
      ])
      .returning({ id: s.importRun.id, state: s.importRun.state })

    // Only the unfinished run keeps its file: a done run has nothing left to
    // resume, and the rows are the largest thing an import stores.
    const unmapped = importRuns.find((run) => run.state === 'mapping')
    if (unmapped) {
      await db.insert(s.importRow).values(
        Array.from({ length: 3 }, (_, position) => ({
          accountId: sandbox,
          runId: unmapped.id,
          position,
          values: {
            'First Name': `Imported${position + 1}`,
            'Last Name': `Row${position + 1}`,
            Email: `imported${position + 1}@partner${position + 1}.example`,
            'Phone Number': '',
            'Company Name': `Partner ${position + 1}`,
            'Lifecycle Stage': 'Lead',
            'Contact owner': 'dana@oldportal.example',
            'Original Source': 'Organic search',
          },
        })),
      )
    }

    // Thirty, because the drawer pages at twenty-five and "read" and "trashed" are
    // states, not filters over one list.
    const NOTIFICATION_KINDS = [
      'task_overdue',
      'form_submission',
      'form_quarantined',
      'deal_stage_change',
      'dead_letter',
      'integration_error',
    ] as const
    await db.insert(s.notification).values(
      Array.from({ length: 30 }, (_, i) => ({
        accountId: sandbox,
        userId: i % 3 === 0 ? salesId : adminId,
        kind: NOTIFICATION_KINDS[i % NOTIFICATION_KINDS.length]!,
        dedupeKey: `seed:${i}`,
        title: `${['A task is overdue', 'A form was filled in', 'A submission was held', 'A deal moved', 'A job could not be delivered', 'An app needs attention'][i % 6]}`,
        body: i % 4 === 0 ? null : 'Seeded so the drawer is never an empty screen in development.',
        entity: i % 6 === 3 ? 'deal' : null,
        entityId: i % 6 === 3 ? (deals[i % Math.max(deals.length, 1)]?.id ?? null) : null,
        actorId: i % 5 === 0 ? marketingId : null,
        count: i === 7 ? 40 : 1,
        readAt: i % 3 === 1 ? dayAgo(i % 5) : null,
        trashedAt: i % 9 === 4 ? dayAgo(1) : null,
        at: dayAgo(i % 14),
      })),
    )

    // The bucket holds no bytes for these. The Files panel lists what a record has
    // and signs a link per read, so a row with no object behind it renders the list
    // correctly and fails only if somebody clicks it.
    await db.insert(s.attachment).values([
      {
        accountId: sandbox,
        entityType: 'deal',
        entityId: deals[0]!.id,
        storageKey: `${sandbox}/seed/proposal.pdf`,
        filename: 'Proposal v3.pdf',
        bytes: 284_120,
        mime: 'application/pdf',
        uploadedBy: salesId,
        at: dayAgo(6),
      },
      {
        accountId: sandbox,
        entityType: 'contact',
        entityId: contacts[0]!.id,
        storageKey: `${sandbox}/seed/security-questionnaire.xlsx`,
        filename: 'Security questionnaire.xlsx',
        bytes: 41_984,
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        uploadedBy: salesId,
        at: dayAgo(4),
      },
    ])

    // An object an admin invented, with its own fields and five rows in the shared
    // table. Not "Project": verify-objects invents that one and asserts it gets the
    // key unclaimed.
    const [assetObject] = await db
      .insert(s.objectDef)
      .values({
        accountId: sandbox,
        key: 'asset',
        nameSingular: 'Asset',
        namePlural: 'Assets',
        isCustom: true,
        icon: 'file',
      })
      .returning({ id: s.objectDef.id })
    if (!assetObject) throw new Error('the custom object was not created')

    const assetFields = await db
      .insert(s.fieldDef)
      .values([
        { accountId: sandbox, objectId: assetObject.id, key: 'name', label: 'Asset name', type: 'text' as const, storage: 'jsonb' as const, isRequired: true, position: 0 },
        { accountId: sandbox, objectId: assetObject.id, key: 'format', label: 'Format', type: 'select' as const, storage: 'jsonb' as const, options: ['Whitepaper', 'Case study', 'Webinar'], position: 1 },
        { accountId: sandbox, objectId: assetObject.id, key: 'published_on', label: 'Published on', type: 'date' as const, storage: 'jsonb' as const, position: 2 },
      ])
      .returning({ id: s.fieldDef.id, key: s.fieldDef.key })

    const nameField = assetFields.find((field) => field.key === 'name')
    if (nameField) {
      await db.update(s.objectDef).set({ labelFieldId: nameField.id }).where(eq(s.objectDef.id, assetObject.id))
    }

    const FORMATS = ['Whitepaper', 'Case study', 'Webinar']
    await db.insert(s.customRecord).values(
      Array.from({ length: 5 }, (_, i) => ({
        accountId: sandbox,
        objectId: assetObject.id,
        custom: {
          name: `${FORMATS[i % FORMATS.length]} ${i + 1}`,
          format: FORMATS[i % FORMATS.length]!,
          published_on: dayAgo(30 - i * 5).toISOString().slice(0, 10),
        },
        ownerId: marketingId,
        createdAt: dayAgo(30 - i * 5),
      })),
    )

    // Three apps in three states, because the Connected Apps table's whole job is
    // telling them apart and one healthy row proves none of it.
    await db.insert(s.integration).values([
      {
        accountId: sandbox,
        kind: 'slack',
        config: { channel: '#sales-leads-2026', mode: 'bot' },
        secretRef: secret('xoxb-seed-not-a-real-token'),
        state: 'connected' as const,
        lastOkAt: dayAgo(0),
        installedBy: adminId,
      },
      {
        accountId: sandbox,
        kind: 'apollo',
        config: { plan: 'basic' },
        secretRef: secret('seed-apollo-key'),
        state: 'degraded' as const,
        lastOkAt: dayAgo(2),
        lastError: 'Rate limited: 429 from /v1/people/match',
        lastErrorAt: dayAgo(0),
        installedBy: adminId,
      },
      {
        accountId: sandbox,
        kind: 'woodpecker',
        config: {},
        secretRef: secret('seed-woodpecker-key'),
        state: 'revoked' as const,
        lastOkAt: dayAgo(9),
        lastError: 'Unauthorized: the API key was revoked at the provider',
        lastErrorAt: dayAgo(1),
        installedBy: adminId,
      },
    ])

    // Everything the builder can put on a form and the seed forms do not: four
    // steps, a question that only appears on one answer, a file, a consent tick and
    // a value the embed sets from the page it sits on.
    await db.insert(s.form).values({
      accountId: sandbox,
      name: 'Partner application',
      slug: 'partner-application',
      schema: [
        { key: 'about_you', type: 'heading', label: 'About you', required: false, step: 0 },
        { key: 'first_name', type: 'text', label: 'First name', required: true, mapsTo: 'contact.first_name', step: 0 },
        { key: 'last_name', type: 'text', label: 'Last name', required: true, mapsTo: 'contact.last_name', step: 0 },
        { key: 'email', type: 'email', label: 'Work email', required: true, mapsTo: 'contact.email', step: 0 },
        { key: 'company', type: 'text', label: 'Company', required: true, mapsTo: 'company.name', step: 1 },
        {
          key: 'partner_type',
          type: 'select',
          label: 'What kind of partner?',
          required: true,
          options: [
            { value: 'reseller', label: 'Reseller' },
            { value: 'agency', label: 'Agency' },
            { value: 'technology', label: 'Technology' },
          ],
          mapsTo: null,
          step: 1,
        },
        {
          key: 'reseller_regions',
          type: 'multi_select',
          label: 'Which regions do you resell in?',
          required: false,
          options: [
            { value: 'emea', label: 'EMEA' },
            { value: 'apac', label: 'APAC' },
            { value: 'amer', label: 'Americas' },
          ],
          visibleIf: { field: 'partner_type', equals: 'reseller' },
          mapsTo: null,
          step: 1,
        },
        { key: 'deck', type: 'file', label: 'Company deck', required: false, mapsTo: null, step: 2,
          help: 'PDF, up to 10MB.' },
        { key: 'notes', type: 'long_text', label: 'Anything else?', required: false, mapsTo: null, step: 2,
          validation: { maxLength: 2000 } },
        { key: 'consent', type: 'consent', label: 'I agree to be contacted about this application.',
          required: true, mapsTo: null, step: 3 },
        { key: 'source_page', type: 'hidden', label: 'Source page', required: false, mapsTo: null, step: 3,
          defaultValue: '/partners' },
      ],
      settings: {
        ...DEFAULT_SETTINGS,
        submitLabel: 'Send application',
        successValue: 'Thanks. The partnerships team reads every one of these.',
        lifecycleStageOnSubmit: 'Lead',
        notifySlack: true,
        slackChannel: '#partners',
        steps: ['About you', 'Your company', 'Supporting material', 'Consent'],
        assignOwner: { mode: 'user', userId: marketingId, pool: [] },
      },
      isActive: true,
    })
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
    union all select 'mailbox', count(*)::int from mailbox
    union all select 'message_thread', count(*)::int from message_thread
    union all select 'sequence', count(*)::int from sequence
    union all select 'sequence_enrollment', count(*)::int from sequence_enrollment
    union all select 'email_template', count(*)::int from email_template
    union all select 'automation', count(*)::int from automation
    union all select 'segment', count(*)::int from segment
    union all select 'import_run', count(*)::int from import_run
    union all select 'report_dashboard', count(*)::int from report_dashboard
    union all select 'notification', count(*)::int from notification
    union all select 'attachment', count(*)::int from attachment
    union all select 'custom_record', count(*)::int from custom_record
    order by t`
  console.log('seeded:')
  for (const row of counts) console.log(`  ${row.t}: ${row.n}`)
  console.log('\ndev sign-in emails: ' + PEOPLE.map((p) => p.email).join(', '))
} finally {
  await client.end()
}
