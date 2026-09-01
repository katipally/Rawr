import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as s from '../src/schema/index.ts'
import type { Role, WorkspaceContext } from '../src/dal/context.ts'
import { ForbiddenError } from '../src/dal/context.ts'
import {
  ConflictError,
  DuplicateError,
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  mergeRecords,
  updateRecord,
} from '../src/dal/records.ts'
import { readTimeline, timelineCounts } from '../src/dal/activity.ts'
import { readBoard } from '../src/dal/board.ts'
import { searchAll } from '../src/dal/search.ts'
import { readSubscriptions, sentenceFor } from '../src/dal/subscriptions.ts'
import { listViews, resolveView } from '../src/dal/views.ts'
import { exportCsv } from '../src/dal/export.ts'
import { createImportRun, runImportChunk, dryRun, suggestMapping, assertMappingIsUsable } from '../src/dal/imports.ts'
import { getRegistry, objectOrThrow, forgetRegistry } from '../src/dal/registry.ts'
import { registrableDomain, isFreeMailDomain } from '../src/dal/domains.ts'
import { closeAppPool } from '../src/internal/pool.ts'

/** The F1 definition of done, run against the real database rather than asserted in
 *  a review. Every check maps to a line in features/01-crm.md. */

const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })
const db = drizzle(owner, { schema: s })

let failures = 0
const pass = (what: string, detail = '') => console.log(`PASS  ${what}${detail ? `  ${detail}` : ''}`)
const fail = (what: string, detail: string) => {
  failures += 1
  console.log(`FAIL  ${what}\n      ${detail}`)
}

const check = async (what: string, fn: () => Promise<string | void>): Promise<void> => {
  try {
    const detail = await fn()
    pass(what, detail ?? '')
  } catch (cause) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
    const inner = cause instanceof Error && cause.cause instanceof Error ? `\n      caused by ${cause.cause.message}` : ''
    fail(what, `${detail}${inner}`)
  }
}

const expect = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
}

try {
  const [datasaur] = await db.select().from(s.workspace).where(eq(s.workspace.slug, 'datasaur'))
  const [probe] = await db.select().from(s.workspace).where(eq(s.workspace.slug, 'probe'))
  if (!datasaur || !probe) throw new Error('Run pnpm db:seed first.')

  const members = await db
    .select({ id: s.userAccount.id, email: s.userAccount.email, role: s.membership.role })
    .from(s.membership)
    .innerJoin(s.userAccount, eq(s.userAccount.id, s.membership.userId))
    .where(eq(s.membership.workspaceId, datasaur.id))

  const ctxFor = (role: Role): WorkspaceContext => {
    const member = members.find((m) => m.role === role)
    if (!member) throw new Error(`no seeded ${role}`)
    return { workspaceId: datasaur.id, actorId: member.id, actorKind: 'user', role }
  }
  const admin = ctxFor('admin')
  const sales = ctxFor('sales')
  const viewer = ctxFor('viewer')
  const probeCtx: WorkspaceContext = {
    workspaceId: probe.id,
    actorId: null,
    actorKind: 'user',
    role: 'admin',
  }

  console.log('\n-- registry and views ------------------------------------------------')

  await check('the registry exposes all three objects with their fields', async () => {
    const registry = await getRegistry(admin)
    expect(registry.objects.length === 3, `saw ${registry.objects.length} objects`)
    const deal = objectOrThrow(registry, 'deal')
    const custom = deal.fields.filter((f) => f.storage === 'jsonb')
    // The two HubSpot properties the seed carries, checked by name. Not by count:
    // custom fields are creatable from Settings now, so a total is a property of
    // whatever somebody has added rather than of the system. A1.
    for (const key of ['uttr_pipeline', 'deal_product_of_interest']) {
      expect(
        custom.some((field) => field.key === key),
        `deal has no custom jsonb field called ${key}`,
      )
    }
    return `deal has ${deal.fields.length} fields, ${custom.length} of them custom jsonb`
  })

  await check('the reserved "all" view resolves for every object', async () => {
    for (const key of ['contact', 'company', 'deal'] as const) {
      const { view, matched } = await resolveView(admin, key, 'all')
      expect(matched, `${key} has no view called all`)
      expect(view.columns.length > 0, `${key}'s all view has no columns`)
    }
    return 'contact, company and deal'
  })

  await check('an unknown view slug falls back instead of failing', async () => {
    const { view, matched } = await resolveView(admin, 'contact', 'a-view-someone-deleted')
    expect(!matched, 'it claimed to match')
    expect(view.slug === 'all', `fell back to ${view.slug}`)
    return 'falls back to all'
  })

  console.log('\n-- domains and auto association --------------------------------------')

  await check('a domain is normalised the same way from a URL, an email and a host', async () => {
    const forms = ['https://WWW.Acme.co.uk/pricing?x=1', 'jo@mail.acme.co.uk', 'acme.co.uk.']
    const results = forms.map(registrableDomain)
    expect(new Set(results).size === 1, `got ${JSON.stringify(results)}`)
    expect(results[0] === 'acme.co.uk', `got ${results[0]}, a public suffix was eaten`)
    return results[0]!
  })

  await check('free and disposable providers are refused as companies', async () => {
    for (const domain of ['gmail.com', 'proton.me', 'mailinator.com', 'qq.com']) {
      expect(isFreeMailDomain(domain), `${domain} was treated as an employer`)
    }
    expect(!isFreeMailDomain('datasaur.ai'), 'datasaur.ai was treated as free mail')
    return 'gmail, proton, mailinator, qq refused; datasaur.ai kept'
  })

  await check('a contact at a known company domain files under that company', async () => {
    const [company] = await db
      .select({ id: s.company.id, domain: s.company.domain })
      .from(s.company)
      .where(and(eq(s.company.workspaceId, datasaur.id), eq(s.company.domain, 'partner1.example')))
    expect(!!company, 'the seeded partner1.example company is missing')

    const created = await createRecord(sales, 'contact', {
      first_name: 'Auto',
      last_name: 'Filed',
      email: `auto.filed.${Date.now()}@partner1.example`,
    })
    const record = await getRecord(sales, 'contact', created.id)
    expect(record?.values.company_id === company!.id, `filed under ${record?.values.company_id}`)
    await deleteRecord(admin, 'contact', created.id)
    return `filed under ${record?.labels.company_id}`
  })

  await check('a gmail.com address does not create a company called Gmail', async () => {
    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.company)
      .where(eq(s.company.workspaceId, datasaur.id))

    const created = await createRecord(sales, 'contact', {
      first_name: 'Free',
      last_name: 'Mail',
      email: `free.mail.${Date.now()}@gmail.com`,
    })
    const record = await getRecord(sales, 'contact', created.id)
    expect(record?.values.company_id === null, 'it was filed under a company')

    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.company)
      .where(eq(s.company.workspaceId, datasaur.id))
    expect(before[0]!.n === after[0]!.n, `company count went ${before[0]!.n} -> ${after[0]!.n}`)
    await deleteRecord(admin, 'contact', created.id)
    return 'no company created, contact left unlinked'
  })

  await check('an unknown work domain creates the company once', async () => {
    const domain = `newco${Date.now()}.example`
    const a = await createRecord(sales, 'contact', { first_name: 'A', email: `a@${domain}` })
    const b = await createRecord(sales, 'contact', { first_name: 'B', email: `b@${domain}` })
    const [recordA, recordB] = await Promise.all([
      getRecord(sales, 'contact', a.id),
      getRecord(sales, 'contact', b.id),
    ])
    expect(
      recordA?.values.company_id === recordB?.values.company_id,
      'two contacts on one domain landed on two companies',
    )
    const companyId = String(recordA?.values.company_id)
    await deleteRecord(admin, 'contact', a.id)
    await deleteRecord(admin, 'contact', b.id)
    await deleteRecord(admin, 'company', companyId)
    return `both filed under ${recordA?.labels.company_id}`
  })

  console.log('\n-- writing, conflicts and duplicates ---------------------------------')

  await check('a duplicate email is refused and names the record to merge with', async () => {
    const email = `dupe.${Date.now()}@partner2.example`
    const first = await createRecord(sales, 'contact', { first_name: 'First', email })
    try {
      await createRecord(sales, 'contact', { first_name: 'Second', email: email.toUpperCase() })
      throw new Error('the duplicate was accepted')
    } catch (cause) {
      expect(cause instanceof DuplicateError, `threw ${String(cause)}`)
      expect((cause as DuplicateError).existingId === first.id, 'it pointed at the wrong record')
    } finally {
      await deleteRecord(admin, 'contact', first.id)
    }
    return 'refused, case insensitively, with the existing id'
  })

  await check('a stale write is refused rather than overwriting', async () => {
    const [deal] = await db
      .select({ id: s.deal.id })
      .from(s.deal)
      .where(eq(s.deal.workspaceId, datasaur.id))
      .limit(1)
    const before = await getRecord(sales, 'deal', deal!.id)
    await updateRecord(sales, 'deal', deal!.id, { next_step: 'Someone else got there first' })
    try {
      await updateRecord(sales, 'deal', deal!.id, { next_step: 'My edit' }, before!.updatedAt)
      throw new Error('the stale write was accepted')
    } catch (cause) {
      expect(cause instanceof ConflictError, `threw ${String(cause)}`)
    }
    const after = await getRecord(sales, 'deal', deal!.id)
    expect(after?.values.next_step === 'Someone else got there first', 'the stale write landed anyway')
    return 'conflict raised, the other edit survived'
  })

  await check('a 500-character name is stored, not rejected', async () => {
    const long = 'x'.repeat(500)
    const created = await createRecord(sales, 'company', { name: long, domain: `long${Date.now()}.example` })
    const record = await getRecord(sales, 'company', created.id)
    expect(String(record?.values.name).length === 500, `stored ${String(record?.values.name).length}`)
    await deleteRecord(admin, 'company', created.id)
    return '500 characters round tripped'
  })

  await check('a value longer than the field allows is cut with a warning, not dropped', async () => {
    const created = await createRecord(sales, 'company', {
      name: 'y'.repeat(900),
      domain: `cut${Date.now()}.example`,
    })
    expect(created.warnings.length === 1, `got ${created.warnings.length} warnings`)
    const record = await getRecord(sales, 'company', created.id)
    expect(String(record?.values.name).length === 500, 'it was not cut to the declared maximum')
    await deleteRecord(admin, 'company', created.id)
    return created.warnings[0]!
  })

  console.log('\n-- timeline ----------------------------------------------------------')

  await check('a stage change writes the sentence nobody typed', async () => {
    const [deal] = await db
      .select({ id: s.deal.id, stageId: s.deal.stageId, pipelineId: s.deal.pipelineId })
      .from(s.deal)
      .where(eq(s.deal.workspaceId, datasaur.id))
      .limit(1)
    const stages = await db
      .select({ id: s.pipelineStage.id, name: s.pipelineStage.name })
      .from(s.pipelineStage)
      .where(eq(s.pipelineStage.pipelineId, deal!.pipelineId))
    const target = stages.find((stage) => stage.id !== deal!.stageId)!

    await updateRecord(sales, 'deal', deal!.id, { stage_id: target.id })
    const page = await readTimeline(sales, {
      entity: { entityType: 'deal', entityId: deal!.id },
      types: ['stage_change'],
      limit: 1,
    })
    const subject = page.rows[0]?.subject ?? ''
    // The actor's name is prefixed at render time from actorName, so the stored
    // sentence starts at the verb.
    expect(subject.startsWith('moved ') && subject.includes(target.name), `subject was "${subject}"`)
    return subject
  })

  await check('a lifecycle change writes an event, and changing it back writes another', async () => {
    const stages = await db
      .select({ id: s.lifecycleStage.id, name: s.lifecycleStage.name })
      .from(s.lifecycleStage)
      .where(eq(s.lifecycleStage.workspaceId, datasaur.id))
      .orderBy(s.lifecycleStage.position)
    const created = await createRecord(sales, 'contact', {
      first_name: 'Cycle',
      email: `cycle.${Date.now()}@partner3.example`,
      lifecycle_stage_id: stages[1]!.id,
    })
    await updateRecord(sales, 'contact', created.id, { lifecycle_stage_id: stages[4]!.id })
    await updateRecord(sales, 'contact', created.id, { lifecycle_stage_id: stages[1]!.id })

    const page = await readTimeline(sales, {
      entity: { entityType: 'contact', entityId: created.id },
      types: ['lifecycle_change'],
    })
    expect(page.rows.length === 2, `saw ${page.rows.length} lifecycle events`)
    // Newest first: the move back must read as the most recent.
    expect(page.rows[0]!.subject!.includes(stages[1]!.name), `newest was "${page.rows[0]!.subject}"`)
    expect(page.rows[1]!.subject!.includes(stages[4]!.name), `oldest was "${page.rows[1]!.subject}"`)
    await deleteRecord(admin, 'contact', created.id)
    return `${page.rows[1]!.subject} then ${page.rows[0]!.subject}`
  })

  await check('a busy timeline pages by keyset and counts by a grouped query', async () => {
    const [deal] = await db
      .select({ id: s.deal.id })
      .from(s.deal)
      .where(eq(s.deal.workspaceId, datasaur.id))
      .orderBy(s.deal.createdAt)
      .limit(1)

    const entity = { entityType: 'deal' as const, entityId: deal!.id }
    const counts = await timelineCounts(sales, entity)
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
    expect(total >= 120, `only ${total} activities on the busy deal`)

    const seen = new Set<string>()
    let cursor = null as Awaited<ReturnType<typeof readTimeline>>['nextCursor']
    let pages = 0
    do {
      const page = await readTimeline(sales, { entity, limit: 50, cursor })
      for (const row of page.rows) {
        expect(!seen.has(row.id), 'the same activity came back on two pages')
        seen.add(row.id)
      }
      cursor = page.nextCursor
      pages += 1
    } while (cursor && pages < 10)

    expect(seen.size === total, `paged ${seen.size} of ${total}`)
    return `${total} activities over ${pages} pages, counts: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', ')}`
  })

  await check('the type filter narrows the timeline and the counts still add up', async () => {
    const [deal] = await db
      .select({ id: s.deal.id })
      .from(s.deal)
      .where(eq(s.deal.workspaceId, datasaur.id))
      .orderBy(s.deal.createdAt)
      .limit(1)
    const entity = { entityType: 'deal' as const, entityId: deal!.id }
    const counts = await timelineCounts(sales, entity)
    const page = await readTimeline(sales, { entity, types: ['note'], limit: 200 })
    expect(page.rows.every((row) => row.type === 'note'), 'a non-note came back')
    expect(page.rows.length === (counts.note ?? 0), `filter gave ${page.rows.length}, count said ${counts.note}`)
    return `note ${page.rows.length}/${Object.values(counts).reduce((a, b) => a + b, 0)}`
  })

  console.log('\n-- merge -------------------------------------------------------------')

  await check('merging preserves every activity and leaves no orphan link', async () => {
    const stamp = Date.now()
    const keep = await createRecord(sales, 'contact', { first_name: 'Keep', email: `keep.${stamp}@partner4.example` })
    const absorb = await createRecord(sales, 'contact', { first_name: 'Absorb', last_name: 'Me', email: `absorb.${stamp}@partner5.example` })

    const { logByHand } = await import('../src/dal/tasks.ts')
    await logByHand(sales, { type: 'note', body: 'note on the survivor', entity: { entityType: 'contact', entityId: keep.id } })
    await logByHand(sales, { type: 'call', body: 'call on the absorbed', entity: { entityType: 'contact', entityId: absorb.id } })

    const before = {
      keep: await timelineCounts(sales, { entityType: 'contact', entityId: keep.id }),
      absorb: await timelineCounts(sales, { entityType: 'contact', entityId: absorb.id }),
    }
    const beforeTotal =
      Object.values(before.keep).reduce((a, b) => a + b, 0) + Object.values(before.absorb).reduce((a, b) => a + b, 0)

    await mergeRecords(sales, {
      objectKey: 'contact',
      survivorId: keep.id,
      absorbedId: absorb.id,
      picks: { last_name: 'absorbed' },
    })

    const after = await timelineCounts(sales, { entityType: 'contact', entityId: keep.id })
    const afterTotal = Object.values(after).reduce((a, b) => a + b, 0)
    // One extra: the merge event itself.
    expect(afterTotal === beforeTotal + 1, `${beforeTotal} activities before, ${afterTotal} after`)

    const orphans = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from activity_link
       where workspace_id = ${datasaur.id} and entity_type = 'contact' and entity_id = ${absorb.id}`)
    expect(Number(orphans[0]!.n) === 0, `${orphans[0]!.n} links left on the absorbed record`)

    const survivor = await getRecord(sales, 'contact', keep.id)
    expect(survivor?.values.last_name === 'Me', `picked last name was ${survivor?.values.last_name}`)
    expect(after.merge === 1, 'no merge event was written')

    await deleteRecord(admin, 'contact', keep.id)
    return `${beforeTotal} activities moved intact, zero orphans, picked field applied`
  })

  console.log('\n-- board -------------------------------------------------------------')

  await check('the Enterprise board reproduces its nine stages with real totals', async () => {
    const [pipeline] = await db
      .select({ id: s.pipeline.id })
      .from(s.pipeline)
      .where(and(eq(s.pipeline.workspaceId, datasaur.id), eq(s.pipeline.name, 'Enterprise')))
    const board = await readBoard(sales, { pipelineId: pipeline!.id })
    expect(board.columns.length === 9, `saw ${board.columns.length} columns`)

    const counted = board.columns.reduce((sum, column) => sum + column.count, 0)
    const stored = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from deal
       where workspace_id = ${datasaur.id} and pipeline_id = ${pipeline!.id} and deleted_at is null`)
    expect(counted === Number(stored[0]!.n), `columns counted ${counted}, table holds ${stored[0]!.n}`)

    const mixed = board.columns.find((column) => column.totals.length > 1)
    return `${counted} deals across 9 columns${mixed ? `, ${mixed.name} subtotals ${mixed.totals.length} currencies separately` : ''}`
  })

  await check('a weighted total uses the stage probability and recomputes on read', async () => {
    const board = await readBoard(sales, {})
    const column = board.columns.find((c) => c.probability && c.probability > 0 && c.totals.some((t) => Number(t.total) > 0))
    expect(!!column, 'no column had both a probability and an amount')
    const total = column!.totals.find((t) => Number(t.total) > 0)!
    const expected = (Number(total.total) * column!.probability!) / 100
    expect(Math.abs(Number(total.weighted) - expected) < 0.01, `weighted ${total.weighted}, expected ${expected}`)
    return `${column!.name} at ${column!.probability}%: ${total.total} -> ${total.weighted} ${total.currency}`
  })

  console.log('\n-- search, views, export ---------------------------------------------')

  await check('search finds a company by a misspelled name', async () => {
    const results = await searchAll(sales, 'Softwre Partnr')
    expect(results.companies.length > 0, 'trigram search returned nothing')
    return `${results.companies.length} companies, top: ${results.companies[0]!.displayName}`
  })

  await check('search finds a contact by an email prefix', async () => {
    const results = await searchAll(sales, 'contact1@')
    expect(results.contacts.length > 0, 'no contact matched the prefix')
    return results.contacts[0]!.displayName
  })

  await check('a filtered list returns only matching rows and pages by keyset', async () => {
    const page = await listRecords(sales, {
      object: 'contact',
      columns: ['first_name', 'email', 'lead_status'],
      filters: [{ conjunction: 'and', conditions: [{ field: 'lead_status', operator: 'is', value: 'New' }] }],
      sorts: [{ key: 'created_at', direction: 'desc' }],
      limit: 5,
    })
    expect(page.rows.every((row) => row.values.lead_status === 'New'), 'a non-matching row came back')
    expect(page.rows.length <= 5, 'the limit was ignored')

    if (page.nextCursor) {
      const second = await listRecords(sales, {
        object: 'contact',
        columns: ['first_name', 'email', 'lead_status'],
        filters: [{ conjunction: 'and', conditions: [{ field: 'lead_status', operator: 'is', value: 'New' }] }],
        sorts: [{ key: 'created_at', direction: 'desc' }],
        limit: 5,
        cursor: page.nextCursor,
      })
      const overlap = second.rows.filter((row) => page.rows.some((first) => first.id === row.id))
      expect(overlap.length === 0, `${overlap.length} rows appeared on both pages`)
    }
    return `${page.rows.length} rows, ${page.nextCursor ? 'paged cleanly' : 'single page'}`
  })

  await check('a custom jsonb field filters and sorts through the registry', async () => {
    const page = await listRecords(sales, {
      object: 'deal',
      columns: ['name', 'uttr_pipeline', 'deal_product_of_interest'],
      filters: [{ conjunction: 'and', conditions: [{ field: 'uttr_pipeline', operator: 'is', value: true }] }],
      sorts: [{ key: 'uttr_pipeline', direction: 'desc' }],
      limit: 50,
    })
    expect(page.rows.length > 0, 'no deal matched the custom boolean')
    expect(page.rows.every((row) => row.values.uttr_pipeline === true), 'a non-matching deal came back')
    return `${page.rows.length} deals on the custom field, products: ${JSON.stringify(page.rows[0]!.values.deal_product_of_interest)}`
  })

  await check('CSV export contains exactly the filtered rows and the visible columns', async () => {
    const columns = ['first_name', 'email', 'lead_status']
    const filters = [{ conjunction: 'and' as const, conditions: [{ field: 'lead_status', operator: 'is' as const, value: 'New' }] }]
    let csv = ''
    for await (const chunk of exportCsv(sales, { objectKey: 'contact', columns, filters, sorts: [] })) csv += chunk

    const lines = csv.trim().split('\n')
    const header = lines[0]!.split(',')
    expect(header.length === 3, `header had ${header.length} columns`)

    const page = await listRecords(sales, { object: 'contact', columns, filters, limit: 200 })
    expect(lines.length - 1 === page.rows.length, `csv had ${lines.length - 1} rows, the view has ${page.rows.length}`)
    return `${lines.length - 1} rows, columns: ${header.join(' | ')}`
  })

  console.log('\n-- subscriptions -----------------------------------------------------')

  await check('a contact with no preference reads as exactly that', async () => {
    const created = await createRecord(sales, 'contact', {
      first_name: 'Never',
      last_name: 'Said',
      email: `never.said.${Date.now()}@partner6.example`,
    })
    const rows = await readSubscriptions(sales, created.id)
    expect(rows.length > 0, 'no subscription types are seeded')
    expect(rows.every((row) => row.state === 'unspecified'), 'a default leaked in as subscribed or unsubscribed')
    const sentence = sentenceFor('Never Said', rows)
    expect(sentence === 'Never Said has not specified any preferences.', `sentence was "${sentence}"`)
    await deleteRecord(admin, 'contact', created.id)
    return sentence!
  })

  console.log('\n-- import ------------------------------------------------------------')

  await check('the same file imported twice creates then updates, with no duplicates', async () => {
    const stamp = Date.now()
    const headers = ['First Name', 'Last Name', 'Email', 'Job Title']
    const rows = Array.from({ length: 20 }, (_, i) => ({
      'First Name': `Imported${i}`,
      'Last Name': `Row${i}`,
      Email: `imported.${stamp}.${i}@partner7.example`,
      'Job Title': 'Analyst',
    }))

    const registry = await getRegistry(admin)
    const object = objectOrThrow(registry, 'contact')
    const mapping = suggestMapping(object, headers)
    assertMappingIsUsable(object, mapping)
    expect(mapping.Email === 'email', `Email mapped to ${mapping.Email}`)

    const runOnce = async () => {
      const run = await createImportRun(admin, { objectKey: 'contact', filename: 'people.csv', headers, rows, mapping })
      let guard = 0
      let done = false
      while (!done && guard < 20) {
        ;({ done } = await runImportChunk(admin, run.id))
        guard += 1
      }
      const { readImportRun } = await import('../src/dal/imports.ts')
      return (await readImportRun(admin, run.id))!
    }

    const first = await runOnce()
    expect(first.created === 20, `first run created ${first.created}`)
    expect(first.updated === 0, `first run updated ${first.updated}`)

    const second = await runOnce()
    expect(second.updated === 20, `second run updated ${second.updated}`)
    expect(second.created === 0, `second run created ${second.created}`)

    const stored = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from contact
       where workspace_id = ${datasaur.id} and email like ${`imported.${stamp}.%`} and deleted_at is null`)
    expect(Number(stored[0]!.n) === 20, `${stored[0]!.n} contacts exist, expected 20`)

    await db.execute(sql`delete from contact where workspace_id = ${datasaur.id} and email like ${`imported.${stamp}.%`}`)
    return '20 created, then 20 updated, 20 rows total'
  })

  await check('a bad date lands in the error list and does not stop the run', async () => {
    const stamp = Date.now()
    const headers = ['Deal Name', 'Close Date']
    const rows = [
      { 'Deal Name': `Import deal ${stamp} a`, 'Close Date': '2026-09-01' },
      { 'Deal Name': `Import deal ${stamp} b`, 'Close Date': 'next tuesday-ish' },
      { 'Deal Name': `Import deal ${stamp} c`, 'Close Date': '2026-10-15' },
    ]
    const registry = await getRegistry(admin)
    const object = objectOrThrow(registry, 'deal')
    const preview = await dryRun(admin, {
      objectKey: 'deal',
      mapping: { 'Deal Name': 'name', 'Close Date': 'close_date' },
      rows,
    })
    expect(preview.willError === 1, `preview expected 1 error, saw ${preview.willError}`)
    expect(preview.samples.error[0]!.row === 3, `the bad row was reported as row ${preview.samples.error[0]!.row}`)
    expect(object.byKey.has('close_date'), 'close_date left the registry')
    return `${preview.willCreate} to create, 1 refused: ${preview.samples.error[0]!.reason}`
  })

  await check('a mapping with two columns on one field is blocked before anything is written', async () => {
    const registry = await getRegistry(admin)
    const object = objectOrThrow(registry, 'contact')
    try {
      assertMappingIsUsable(object, { Email: 'email', 'E-mail': 'email' })
      throw new Error('the mapping was accepted')
    } catch (cause) {
      expect(cause instanceof Error && cause.message.includes('both mapped to'), `threw "${String(cause)}"`)
      return (cause as Error).message
    }
  })

  await check('a mapping with no dedupe column is blocked', async () => {
    const registry = await getRegistry(admin)
    const object = objectOrThrow(registry, 'contact')
    try {
      assertMappingIsUsable(object, { 'First Name': 'first_name' })
      throw new Error('the mapping was accepted')
    } catch (cause) {
      expect(cause instanceof Error && cause.message.includes('duplicates'), `threw "${String(cause)}"`)
      return (cause as Error).message
    }
  })

  console.log('\n-- roles and tenancy -------------------------------------------------')

  await check('a viewer is refused on every object, by the data access layer', async () => {
    for (const object of ['contact', 'company', 'deal'] as const) {
      try {
        await createRecord(viewer, object, { name: 'nope', first_name: 'nope', email: `v${Date.now()}@x.example` })
        throw new Error(`viewer created a ${object}`)
      } catch (cause) {
        expect(cause instanceof ForbiddenError, `${object} threw ${String(cause)}`)
      }
    }
    return 'contact, company and deal all refused'
  })

  await check('marketing cannot write deals but sales can', async () => {
    const marketing = ctxFor('marketing')
    try {
      await createRecord(marketing, 'deal', { name: 'nope' })
      throw new Error('marketing created a deal')
    } catch (cause) {
      expect(cause instanceof ForbiddenError, `threw ${String(cause)}`)
    }
    return (await import('../src/dal/context.ts')).canWrite('sales', 'deal') ? 'marketing refused, sales allowed' : 'sales was also refused'
  })

  await check('a viewer can still read the pipeline', async () => {
    const board = await readBoard(viewer, {})
    expect(board.columns.length > 0, 'the viewer saw no columns')
    return `${board.columns.length} columns visible to the viewer role`
  })

  await check('authenticated as the probe tenant, no Datasaur record is visible', async () => {
    forgetRegistry(probe.id)
    // Compared by id, not by email: both tenants are seeded from the same
    // template, so matching on an address would flag the probe's own row.
    const datasaurIds = new Set(
      (await db.select({ id: s.contact.id }).from(s.contact).where(eq(s.contact.workspaceId, datasaur.id))).map(
        (row) => row.id,
      ),
    )
    const page = await listRecords(probeCtx, { object: 'contact', limit: 200 })
    const leaked = page.rows.filter((row) => datasaurIds.has(row.id))
    expect(leaked.length === 0, `${leaked.length} Datasaur contacts leaked`)

    const [deal] = await db
      .select({ id: s.deal.id })
      .from(s.deal)
      .where(eq(s.deal.workspaceId, datasaur.id))
      .limit(1)
    const stolen = await getRecord(probeCtx, 'deal', deal!.id)
    expect(stolen === null, 'a Datasaur deal was readable by id from the probe tenant')

    const timeline = await readTimeline(probeCtx, { entity: { entityType: 'deal', entityId: deal!.id } })
    expect(timeline.rows.length === 0, `${timeline.rows.length} activities leaked across tenants`)
    return `probe sees ${page.rows.length} of its own contacts, zero of Datasaur's, and cannot read one by id`
  })

  await check('the probe tenant renders correctly with exactly one row', async () => {
    const page = await listRecords(probeCtx, { object: 'company', limit: 50 })
    expect(page.rows.length === 1, `saw ${page.rows.length} companies`)
    const views = await listViews(probeCtx, 'company')
    expect(views.length > 0, 'the one-row tenant has no views')
    return `1 company, ${views.length} view(s)`
  })

  console.log('')
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`)
    process.exitCode = 1
  } else {
    console.log('all CRM checks passed.')
  }
} finally {
  await owner.end()
  await closeAppPool()
}
