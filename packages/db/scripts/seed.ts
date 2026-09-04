import { and, eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { readAttribution, sourceFrom } from '../src/dal/attribution.ts'
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
    union all select 'booking_page', count(*)::int from booking_page
    union all select 'booking_host', count(*)::int from booking_host
    union all select 'availability', count(*)::int from availability
    order by t`
  console.log('seeded:')
  for (const row of counts) console.log(`  ${row.t}: ${row.n}`)
  console.log('\ndev sign-in emails: ' + PEOPLE.map((p) => p.email).join(', '))
} finally {
  await client.end()
}
