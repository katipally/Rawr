import { eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import {
  CORE_OBJECTS,
  ENTERPRISE_STAGES,
  LIFECYCLE_STAGES,
  SALES_STAGES,
} from '../src/registry/core.ts'
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
            storage: 'column' as const,
            columnName: f.columnName,
            isCustom: false,
            isRequired: f.isRequired ?? false,
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
        email: i === 9 ? null : `contact${i + 1}@partner${i + 1}.example`,
        phone: i % 3 === 0 ? null : `+62 21 5555 ${1000 + i}`,
        title: i === 8 ? LONG_NAME : 'Head of Data',
        linkedinUrl: i % 4 === 0 ? null : `https://www.linkedin.com/in/contact${i + 1}`,
        // Row 1 has no company: an unlinked contact is normal, not an error.
        companyId: i === 1 ? null : (companies[i % companies.length]?.id ?? null),
        ownerId: ownerFor(i),
        lifecycleStageId: stages[i % stages.length]?.id ?? null,
        leadStatus: i % 2 === 0 ? 'New' : 'Open',
        marketingStatus: i % 5 === 0 ? 'Non-marketing contact' : 'Marketing contact',
        createdAt: dayAgo(scale - i),
        originalSource: { channel: 'paid_search', raw_query: 'gclid=seed', referrer: null },
      })),
    )

    await db.insert(s.deal).values(
      Array.from({ length: scale }, (_, i) => ({
        workspaceId: ws,
        name: i === 6 ? null : `${INDUSTRIES[i % 5]} rollout ${i + 1}`,
        pipelineId: enterprise.id,
        stageId: enterpriseStages[i % enterpriseStages.length]!.id,
        // Zero and null amounts both exist in the real portal.
        amount: i === 0 ? '0' : i === 11 ? null : String((i + 1) * 25_000),
        currency: 'USD',
        closeDate: i === 12 ? null : dayAgo(-(i + 5)).toISOString().slice(0, 10),
        nextStep: i % 3 === 0 ? null : 'Send revised pricing',
        ownerId: ownerFor(i),
        companyId: companies[i % companies.length]?.id ?? null,
        dealType: i % 2 === 0 ? 'New Business' : 'Existing Business',
        createdAt: dayAgo(scale - i),
      })),
    )
  }

  const counts = await client`
    select 'company' as t, count(*)::int as n from company
    union all select 'contact', count(*)::int from contact
    union all select 'deal', count(*)::int from deal
    union all select 'field_def', count(*)::int from field_def
    union all select 'pipeline_stage', count(*)::int from pipeline_stage
    order by t`
  console.log('seeded:')
  for (const row of counts) console.log(`  ${row.t}: ${row.n}`)
  console.log('\ndev sign-in emails: ' + PEOPLE.map((p) => p.email).join(', '))
} finally {
  await client.end()
}
