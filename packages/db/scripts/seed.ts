import { and, eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { channelOfSession, readAttribution, sourceFrom } from '../src/dal/attribution.ts'
import { provisionWorkspace } from '../src/dal/provision.ts'
import { SEED_FORMS } from '../src/registry/forms.ts'
import * as s from '../src/schema/index.ts'

/** Roughly 20 of each, covering every state the UI has to survive: empty, one, a
 *  500-character name, missing owner, missing company, zero amount. Production-scale
 *  load testing lives in feature 07 with the importer that needs it. D9.
 *
 *  Two workspaces, always. The second one exists so the cross-tenant test has
 *  something real to fail against. */

const url = process.env.DATABASE_URL_OWNER
if (!url) throw new Error('DATABASE_URL_OWNER is not set.')

const client = postgres(url, { max: 1, onnotice: () => {} })
const db = drizzle(client, { schema: s })

/** Two organisations, and Datasaur owns two workspaces: one company with more
 *  than one place to keep records is the case the org layer exists for, so the
 *  seed has to contain it or nothing exercises it. */
const ORGANISATIONS = [
  { name: 'Datasaur', slug: 'datasaur', domain: 'datasaur.ai', seatLimit: 25 },
  { name: 'Probe', slug: 'probe', domain: 'probe.example', seatLimit: null },
] as const

const WORKSPACES = [
  { name: 'Datasaur', slug: 'datasaur', org: 'datasaur' },
  { name: 'Datasaur EMEA', slug: 'datasaur-emea', org: 'datasaur' },
  { name: 'Probe Tenant', slug: 'probe', org: 'probe' },
] as const

/** One account per role, named for the role. A real person signs in with Google,
 *  lands as a viewer, and is raised from Settings, so nobody's name is seeded. */
const PEOPLE = [
  { email: 'admin@datasaur.ai', name: 'Admin', role: 'admin' as const },
  { email: 'sales@datasaur.ai', name: 'Sales', role: 'sales' as const },
  { email: 'marketing@datasaur.ai', name: 'Marketing', role: 'marketing' as const },
  { email: 'viewer@datasaur.ai', name: 'Viewer', role: 'viewer' as const },
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
  // Idempotent: the whole organisation goes, cascades take its workspaces and
  // every record in them.
  const existingOrgs = await db
    .select({ id: s.organisation.id })
    .from(s.organisation)
    .where(inArray(s.organisation.slug, ORGANISATIONS.map((o) => o.slug)))
  if (existingOrgs.length) {
    await db.delete(s.organisation).where(inArray(s.organisation.id, existingOrgs.map((o) => o.id)))
  }

  const organisations = await db
    .insert(s.organisation)
    .values(
      ORGANISATIONS.map((o) => ({
        name: o.name,
        slug: o.slug,
        googleHostedDomain: o.domain,
        seatLimit: o.seatLimit,
      })),
    )
    .returning({ id: s.organisation.id, slug: s.organisation.slug })

  const orgId = (slug: string) => {
    const found = organisations.find((o) => o.slug === slug)
    if (!found) throw new Error(`organisation ${slug} was not created`)
    return found.id
  }

  const workspaces = await db
    .insert(s.workspace)
    .values(WORKSPACES.map((w) => ({ name: w.name, slug: w.slug, organisationId: orgId(w.org) })))
    .returning({ id: s.workspace.id, slug: s.workspace.slug })

  const wsId = (slug: string) => {
    const found = workspaces.find((w) => w.slug === slug)
    if (!found) throw new Error(`workspace ${slug} was not created`)
    return found.id
  }
  const datasaur = wsId('datasaur')
  const emea = wsId('datasaur-emea')
  const probe = wsId('probe')

  const users = await db
    .insert(s.userAccount)
    .values([
      ...PEOPLE.map((p) => ({ email: p.email, name: p.name, googleSub: `dev:${p.email}` })),
      { email: 'admin@probe.example', name: 'Probe Admin', googleSub: 'dev:admin@probe.example' },
      // Somebody whose access was ended. The row stays so the audit trail still
      // names them, and every membership they hold stops answering.
      { email: 'former@datasaur.ai', name: 'Former', googleSub: 'dev:former@datasaur.ai' },
    ])
    .onConflictDoUpdate({ target: s.userAccount.email, set: { name: sql`excluded.name` } })
    .returning({ id: s.userAccount.id, email: s.userAccount.email })

  const userId = (email: string) => {
    const found = users.find((u) => u.email === email)
    if (!found) throw new Error(`user ${email} was not created`)
    return found.id
  }

  await db.insert(s.membership).values([
    ...PEOPLE.map((p) => ({ workspaceId: datasaur, userId: userId(p.email), role: p.role })),
    // The second Datasaur workspace has its own smaller seating, which is what
    // makes "which workspace am I in" a real question in the switcher.
    { workspaceId: emea, userId: userId('admin@datasaur.ai'), role: 'admin' as const },
    { workspaceId: emea, userId: userId('sales@datasaur.ai'), role: 'sales' as const },
    { workspaceId: probe, userId: userId('admin@probe.example'), role: 'admin' as const },
    { workspaceId: datasaur, userId: userId('former@datasaur.ai'), role: 'sales' as const },
  ])

  await db.insert(s.organisationMembership).values([
    { organisationId: orgId('datasaur'), userId: userId('admin@datasaur.ai'), role: 'org_admin' as const },
    ...PEOPLE.filter((p) => p.role !== 'admin').map((p) => ({
      organisationId: orgId('datasaur'),
      userId: userId(p.email),
      role: 'member' as const,
    })),
    {
      organisationId: orgId('datasaur'),
      userId: userId('former@datasaur.ai'),
      role: 'member' as const,
      state: 'deactivated' as const,
      deactivatedAt: dayAgo(3),
      deactivatedBy: userId('admin@datasaur.ai'),
    },
    { organisationId: orgId('probe'), userId: userId('admin@probe.example'), role: 'org_admin' as const },
  ])

  // One seat offered and not yet claimed, so the pending tab is never empty in
  // development. The hash is of a token nobody holds; the link cannot be used.
  await db.insert(s.invitation).values({
    organisationId: orgId('datasaur'),
    workspaceId: datasaur,
    email: 'newstarter@datasaur.ai',
    workspaceRole: 'sales' as const,
    orgRole: 'member' as const,
    tokenHash: 'seed-invitation-hash-not-a-usable-token',
    invitedBy: userId('admin@datasaur.ai'),
    expiresAt: new Date(Date.UTC(2026, 8, 30)),
  })

  const [salesTeam] = await db
    .insert(s.team)
    .values({ workspaceId: datasaur, name: 'Sales EMEA', description: 'Works European inbound.' })
    .returning({ id: s.team.id })
  if (!salesTeam) throw new Error('the team was not created')
  await db.insert(s.teamMember).values([
    { workspaceId: datasaur, teamId: salesTeam.id, userId: userId('sales@datasaur.ai'), isLead: true },
    { workspaceId: datasaur, teamId: salesTeam.id, userId: userId('marketing@datasaur.ai') },
  ])

  const owners = PEOPLE.filter((p) => p.role !== 'viewer').map((p) => userId(p.email))

  for (const ws of [datasaur, emea, probe]) {
    // The same provisioning a workspace created from the organisation screen gets,
    // so a seeded workspace and a real one cannot differ.
    await provisionWorkspace(db as unknown as Parameters<typeof provisionWorkspace>[0], ws)

    const stages = await db
      .select({ id: s.lifecycleStage.id, name: s.lifecycleStage.name })
      .from(s.lifecycleStage)
      .where(eq(s.lifecycleStage.workspaceId, ws))
      .orderBy(s.lifecycleStage.position)

    const enterpriseStages = await db
      .select({ id: s.pipelineStage.id, name: s.pipelineStage.name, pipelineId: s.pipelineStage.pipelineId })
      .from(s.pipelineStage)
      .innerJoin(s.pipeline, eq(s.pipeline.id, s.pipelineStage.pipelineId))
      .where(and(eq(s.pipelineStage.workspaceId, ws), eq(s.pipeline.name, 'Enterprise')))
      .orderBy(s.pipelineStage.position)
    const enterpriseId = enterpriseStages[0]?.pipelineId
    if (!enterpriseId) throw new Error('the Enterprise pipeline was not provisioned')

    // The probe tenant gets one record of each, which is also the "exactly one row"
    // case every list has to render correctly.
    const scale = ws === datasaur ? 20 : 1
    const ownerFor = (i: number) => (ws === datasaur ? (owners[i % owners.length] ?? null) : null)

    const companies = await db
      .insert(s.company)
      .values(
        Array.from({ length: scale }, (_, i) => ({
          workspaceId: ws,
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
        workspaceId: ws,
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
      .where(eq(s.contact.workspaceId, ws))

    const deals = await db
      .insert(s.deal)
      .values(
        Array.from({ length: scale }, (_, i) => ({
          workspaceId: ws,
          name: i === 6 ? null : `${INDUSTRIES[i % 5]} rollout ${i + 1}`,
          pipelineId: enterpriseId,
          stageId: enterpriseStages[i % enterpriseStages.length]!.id,
          // Zero and null amounts both exist in the real portal.
          amount: i === 0 ? '0' : i === 11 ? null : String((i + 1) * 25_000),
          // One deal off USD, so the board proves it subtotals per currency
          // instead of adding two currencies together.
          currency: i === 14 ? 'EUR' : 'USD',
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
        return contact ? [{ workspaceId: ws, fromType: 'contact' as const, fromId: contact.id, toType: 'deal' as const, toId: deal.id, label: 'Decision maker' }] : []
      }),
    )

    // A timeline with something on it. One deal gets 120 entries so the keyset
    // pagination and the per-type counts are exercised, not just rendered.
    const busy = deals[0]
    if (busy) {
      const entries = Array.from({ length: 120 }, (_, i) => ({
        workspaceId: ws,
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
          workspaceId: ws,
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
        workspaceId: ws,
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
      .where(eq(s.subscriptionType.workspaceId, ws))
    const newsletter = subTypes.find((t) => t.name === 'Newsletter')
    if (newsletter && contacts.length > 1) {
      await db.insert(s.subscriptionState).values([
        { workspaceId: ws, contactId: contacts[0]!.id, subscriptionTypeId: newsletter.id, state: 'subscribed' as const, source: 'seed' },
        { workspaceId: ws, contactId: contacts[1]!.id, subscriptionTypeId: newsletter.id, state: 'unsubscribed' as const, source: 'seed' },
      ])
    }
  }

  // F3. Every workspace gets the same starting forms, including the probe tenant,
  // so the cross-tenant test has a form on both sides to prove isolation with.
  for (const ws of [datasaur, emea, probe]) {
    await db.insert(s.form).values(
      SEED_FORMS.map((form) => ({
        workspaceId: ws,
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
    { workspaceId: datasaur, name: 'Marketing site', host: 'datasaur.ai', siteKey: 'datasaur-www' },
    { workspaceId: probe, name: 'Probe site', host: 'probe.example', siteKey: 'probe-www' },
  ])

  // F4 and B7. Traffic, so the website and attribution reports have something to
  // report on and the visit history on a contact has something to show. Without
  // these rows four screens render their empty state on a seeded database, which
  // makes them impossible to judge and easy to break unnoticed.
  {
    const [site] = await db
      .select({ id: s.site.id })
      .from(s.site)
      .where(eq(s.site.workspaceId, datasaur))
    const seen = await db
      .select({ id: s.contact.id, email: s.contact.email })
      .from(s.contact)
      .where(eq(s.contact.workspaceId, datasaur))

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
        workspaceId: datasaur,
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
          workspaceId: datasaur,
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
          workspaceId: datasaur,
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
            workspaceId: datasaur,
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
      .where(eq(s.form.workspaceId, datasaur))
    if (forms.length > 0) {
      await db.insert(s.formSubmission).values(
        identified.slice(0, 14).map((session, i) => {
          const held = i === 3 || i === 9
          const form = forms[i % forms.length]!
          return {
            workspaceId: datasaur,
            formId: form.id,
            values: {
              email: session.contact!.email ?? `seed${i}@partner${i}.example`,
              first_name: `Contact${i + 1}`,
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
            spamScore: held ? 78 : 0,
            spamState: held ? ('quarantined' as const) : ('clean' as const),
            spamReasons: held ? ['link_in_message', 'shouting'] : [],
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

  for (const ws of [datasaur, emea, probe]) {
    const staff =
      ws === datasaur
        ? PEOPLE.filter((p) => p.role !== 'viewer').map((p) => userId(p.email))
        : [userId('admin@probe.example')]

    await db.insert(s.availability).values(
      staff.map((id, i) => ({
        workspaceId: ws,
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
    // of busy time. It is what makes the engine exercisable while open item 3 is
    // outstanding, and the web layer refuses it outside development.
    await db.insert(s.calendarGrant).values(
      staff.map((id) => ({
        workspaceId: ws,
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
        workspaceId: ws,
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
        workspaceId: ws,
        bookingPageId: roundRobin.id,
        userId: id,
        // Uneven on purpose: an even split hides a weighting bug.
        weight: i === 0 ? 2 : 1,
      })),
    )

    const owner = staff[0]!
    const [personal] = await db
      .insert(s.bookingPage)
      .values({
        workspaceId: ws,
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
      .values({ workspaceId: ws, bookingPageId: personal.id, userId: owner, weight: 1 })

    // F2. Meetings on the books, two ahead and two behind, so the booked list is
    // not an empty screen on a seeded database and the upcoming and past tabs
    // both have something to show.
    if (ws === datasaur) {
      const booked = await db
        .select({ id: s.contact.id, email: s.contact.email, firstName: s.contact.firstName })
        .from(s.contact)
        .where(eq(s.contact.workspaceId, ws))
        .limit(4)
      await db.insert(s.booking).values(
        booked.map((contact, i) => {
          // Relative to the real clock rather than to the seed's own anchor,
          // because "upcoming" has to still be upcoming whenever the seed is run.
          const day = new Date()
          day.setUTCHours(17, 0, 0, 0)
          const startsAt = new Date(day.getTime() + (i < 2 ? 3 + i * 4 : -(4 + i * 3)) * 86_400_000)
          return {
            workspaceId: ws,
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
            cancelToken: `seed-cancel-${i}`,
            rescheduleToken: `seed-reschedule-${i}`,
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
    order by t`
  console.log('seeded:')
  for (const row of counts) console.log(`  ${row.t}: ${row.n}`)
  console.log('\ndev sign-in emails: ' + PEOPLE.map((p) => p.email).join(', '))
} finally {
  await client.end()
}
