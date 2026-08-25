import { eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import {
  CORE_OBJECTS,
  CORE_VIEWS,
  ENTERPRISE_STAGES,
  LIFECYCLE_STAGES,
  SALES_STAGES,
} from '../src/registry/core.ts'
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

const WORKSPACES = [
  { name: 'Datasaur', slug: 'datasaur', domain: 'datasaur.ai' },
  { name: 'Probe Tenant', slug: 'probe', domain: 'probe.example' },
] as const

const PEOPLE = [
  { email: 'trevor@datasaur.ai', name: 'Trevor Kwan', role: 'sales' as const },
  { email: 'ivan@datasaur.ai', name: 'Ivan Lee', role: 'admin' as const },
  { email: 'andrew@datasaur.ai', name: 'Andrew Chan', role: 'marketing' as const },
  { email: 'viewer@datasaur.ai', name: 'Read Only', role: 'viewer' as const },
]

const INDUSTRIES = ['Software', 'Financial Services', 'Healthcare', 'Government', 'Education']
const COUNTRIES = ['United States', 'Indonesia', 'Singapore', 'United Kingdom', 'Germany']
const LONG_NAME = 'Ludwigshafen Interkontinentale Datenverarbeitungsgesellschaft '.repeat(9).slice(0, 500)

const dayAgo = (n: number) => new Date(Date.UTC(2026, 7, 23) - n * 86_400_000)

try {
  // Idempotent: the whole tenant goes, cascades take its records with it.
  const existing = await db
    .select({ id: s.workspace.id })
    .from(s.workspace)
    .where(inArray(s.workspace.slug, WORKSPACES.map((w) => w.slug)))
  if (existing.length) {
    await db.delete(s.workspace).where(inArray(s.workspace.id, existing.map((w) => w.id)))
  }

  const workspaces = await db
    .insert(s.workspace)
    .values(WORKSPACES.map((w) => ({ name: w.name, slug: w.slug, googleHostedDomain: w.domain })))
    .returning({ id: s.workspace.id, slug: s.workspace.slug })

  const wsId = (slug: string) => {
    const found = workspaces.find((w) => w.slug === slug)
    if (!found) throw new Error(`workspace ${slug} was not created`)
    return found.id
  }
  const datasaur = wsId('datasaur')
  const probe = wsId('probe')

  const users = await db
    .insert(s.userAccount)
    .values([
      ...PEOPLE.map((p) => ({ email: p.email, name: p.name, googleSub: `dev:${p.email}` })),
      { email: 'admin@probe.example', name: 'Probe Admin', googleSub: 'dev:admin@probe.example' },
    ])
    .onConflictDoUpdate({ target: s.userAccount.email, set: { name: s.userAccount.name } })
    .returning({ id: s.userAccount.id, email: s.userAccount.email })

  const userId = (email: string) => {
    const found = users.find((u) => u.email === email)
    if (!found) throw new Error(`user ${email} was not created`)
    return found.id
  }

  await db.insert(s.membership).values([
    ...PEOPLE.map((p) => ({ workspaceId: datasaur, userId: userId(p.email), role: p.role })),
    { workspaceId: probe, userId: userId('admin@probe.example'), role: 'admin' as const },
  ])

  const owners = PEOPLE.filter((p) => p.role !== 'viewer').map((p) => userId(p.email))

  for (const ws of [datasaur, probe]) {
    const stages = await db
      .insert(s.lifecycleStage)
      .values(LIFECYCLE_STAGES.map((name, i) => ({ workspaceId: ws, name, position: i })))
      .returning({ id: s.lifecycleStage.id, name: s.lifecycleStage.name })

    await db.insert(s.subscriptionType).values([
      { workspaceId: ws, name: 'Product updates', description: 'Release notes and changelog.' },
      { workspaceId: ws, name: 'Newsletter', description: 'The monthly newsletter.' },
      { workspaceId: ws, name: 'One-to-one sales email', description: 'Direct email from a rep.' },
      { workspaceId: ws, name: 'Internal notifications', isInternal: true },
    ])

    for (const obj of CORE_OBJECTS) {
      const [objectDef] = await db
        .insert(s.objectDef)
        .values({
          workspaceId: ws,
          key: obj.key,
          nameSingular: obj.nameSingular,
          namePlural: obj.namePlural,
          icon: obj.icon,
          isCustom: false,
        })
        .returning({ id: s.objectDef.id })
      if (!objectDef) throw new Error(`object_def ${obj.key} was not created`)

      const fields = await db
        .insert(s.fieldDef)
        .values(
          obj.fields.map((f) => ({
            workspaceId: ws,
            objectId: objectDef.id,
            key: f.key,
            label: f.label,
            type: f.type,
            // No column means the field lives in custom jsonb, which is how a
            // HubSpot custom property arrives.
            storage: f.columnName ? ('column' as const) : ('jsonb' as const),
            columnName: f.columnName ?? null,
            isCustom: !f.columnName,
            isRequired: f.isRequired ?? false,
            trackChanges: f.trackChanges ?? false,
            options: f.options ?? null,
            position: f.position,
          })),
        )
        .returning({ id: s.fieldDef.id, key: s.fieldDef.key })

      const labelField = fields.find((f) => f.key === obj.labelFieldKey)
      if (labelField) {
        await db
          .update(s.objectDef)
          .set({ labelFieldId: labelField.id })
          .where(eq(s.objectDef.id, objectDef.id))
      }

      // 'all' is the slug every deep link falls back to, so it is seeded, not
      // created on demand.
      await db.insert(s.savedView).values(
        CORE_VIEWS[obj.key].map((view) => ({
          workspaceId: ws,
          objectId: objectDef.id,
          slug: view.slug,
          name: view.name,
          kind: view.kind,
          columns: view.columns,
          filters: view.filters ?? [],
          sorts: view.sorts ?? [],
          isShared: true,
          position: view.position,
          groupByFieldId: view.groupBy ? (fields.find((f) => f.key === view.groupBy)?.id ?? null) : null,
        })),
      )
    }

    const pipelines = await db
      .insert(s.pipeline)
      .values([
        { workspaceId: ws, name: 'Enterprise', position: 0 },
        { workspaceId: ws, name: 'Sales Pipeline', position: 1 },
      ])
      .returning({ id: s.pipeline.id, name: s.pipeline.name })

    const enterprise = pipelines.find((p) => p.name === 'Enterprise')!
    const sales = pipelines.find((p) => p.name === 'Sales Pipeline')!

    const enterpriseStages = await db
      .insert(s.pipelineStage)
      .values(
        ENTERPRISE_STAGES.map((st, i) => ({
          workspaceId: ws,
          pipelineId: enterprise.id,
          name: st.name,
          probability: st.probability,
          position: i,
          isClosedWon: 'isClosedWon' in st,
          isClosedLost: 'isClosedLost' in st,
        })),
      )
      .returning({ id: s.pipelineStage.id, name: s.pipelineStage.name })

    await db.insert(s.pipelineStage).values(
      SALES_STAGES.map((st, i) => ({
        workspaceId: ws,
        pipelineId: sales.id,
        name: st.name,
        probability: st.probability,
        position: i,
        isClosedWon: 'isClosedWon' in st,
        isClosedLost: 'isClosedLost' in st,
      })),
    )

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
        originalSource: { channel: 'paid_search', raw_query: 'gclid=seed', referrer: null },
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
          pipelineId: enterprise.id,
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
  for (const ws of [datasaur, probe]) {
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

  for (const ws of [datasaur, probe]) {
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
