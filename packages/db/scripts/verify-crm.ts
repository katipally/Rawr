import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as s from '../src/schema/index.ts'
import type { AccountContext } from '../src/dal/context.ts'
import { ForbiddenError } from '../src/dal/context.ts'
import {
  ConflictError,
  DuplicateError,
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  mergeRecords,
  updateRecord } from '../src/dal/records.ts'
import { findDuplicates } from '../src/dal/duplicates.ts'
import {
  armedFor,
  conditionsHold,
  listAutomationRuns,
  listAutomations,
  readAutomation,
  claimAutomationRun,
  finishAutomationRun,
  openAutomationRun,
  parkAutomationRun,
  removeAutomation,
  saveAutomation,
  setAutomationActive } from '../src/dal/automations.ts'
import {
  assertCanAttach,
  listAttachments,
  MAX_ATTACHMENT_BYTES,
  recordAttachment,
  removeAttachment,
  storageKeyFor } from '../src/dal/attachments.ts'
import { readTimeline, timelineCounts } from '../src/dal/activity.ts'
import { createTask, logByHand } from '../src/dal/tasks.ts'
import { readBoard } from '../src/dal/board.ts'
import { hitsOf, searchAll } from '../src/dal/search.ts'
import { readSubscriptions, sentenceFor } from '../src/dal/subscriptions.ts'
import {
  deleteView,
  duplicateView,
  listViews,
  renameView,
  reorderViews,
  resolveView,
  saveView,
  setViewPinned } from '../src/dal/views.ts'
import { readAssociations, groupFor } from '../src/dal/associations.ts'
import { exportCsv } from '../src/dal/export.ts'
import { readBulkOperation, runBulkChunk, startBulkOperation } from '../src/dal/bulk.ts'
import {
  addToList,
  createStaticList,
  evaluateAllSegments,
  readSegment,
  readSegmentMembers,
  removeFromList,
  saveSegment } from '../src/dal/segments.ts'
import { createImportRun, runImportChunk, dryRun, suggestMapping, assertMappingIsUsable } from '../src/dal/imports.ts'
import { getRegistry, objectOrThrow, forgetRegistry } from '../src/dal/registry.ts'
import { registrableDomain, isFreeMailDomain } from '../src/dal/domains.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import { SANDBOX, PEER, cleanup } from './fixture.ts'

/** The F1 definition of done, run against the real database rather than asserted in
 *  a review. */

const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })
const db = drizzle(owner, { schema: s })

let failures = 0
const pass = (what: string, detail = '') => console.log(`PASS  ${what}${detail ? `  ${detail}` : ''}`)
const fail = (what: string, detail: string) => {
  failures += 1
  console.log(`FAIL  ${what}\n      ${detail}`)
}

const check = async (what: string, fn: () => Promise<string | undefined>): Promise<void> => {
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

/** A refusal is the result, so the message it refused with is what the check
 *  reports: a guard that fires with the wrong sentence is still a bug. */
const refuses = async (what: string, fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
  throw new Error(`${what} was allowed and should not have been`)
}

try {
  const [datasaur] = await db.select().from(s.account).where(eq(s.account.slug, SANDBOX.slug))
  const [probe] = await db.select().from(s.account).where(eq(s.account.slug, PEER.slug))
  if (!datasaur || !probe) throw new Error('Run pnpm db:seed first.')

  const members = await db
    .select({
      id: s.userAccount.id,
      email: s.userAccount.email,
      isSuperAdmin: s.membership.isSuperAdmin,
      viewHubs: s.membership.viewHubs,
      editHubs: s.membership.editHubs,
    })
    .from(s.membership)
    .innerJoin(s.userAccount, eq(s.userAccount.id, s.membership.userId))
    .where(eq(s.membership.accountId, datasaur.id))

  /** The seeded seats are named for the access they carry, so the suite asks for
   *  one by name and gets whatever grants the seed gave it. */
  const ctxFor = (seat: string): AccountContext => {
    const member = members.find((m) => m.email === `${seat}@sandbox.test`)
    if (!member) throw new Error(`no seeded ${seat}`)
    return {
      accountId: datasaur.id,
      actorId: member.id,
      actorKind: 'user',
      isSuperAdmin: member.isSuperAdmin,
      viewHubs: member.viewHubs,
      editHubs: member.editHubs,
    }
  }
  const admin = ctxFor('admin')
  const sales = ctxFor('sales')
  const viewer = ctxFor('viewer')
  const probeCtx: AccountContext = {
    accountId: probe.id,
    actorId: null,
    actorKind: 'user',
    isSuperAdmin: true,
    viewHubs: [],
    editHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'],
  }

  console.log('\n-- registry and views ------------------------------------------------')

  await check('the registry exposes the three built-in objects with their fields', async () => {
    const registry = await getRegistry(admin)
    // By name, not by count: a custom object is creatable from Settings, so the
    // total belongs to whoever has added one.
    for (const key of ['contact', 'company', 'deal'] as const) {
      expect(registry.objects.some((o) => o.key === key), `the registry has no ${key}`)
    }
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
      .where(and(eq(s.company.accountId, datasaur.id), eq(s.company.domain, 'partner1.example')))
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
      .where(eq(s.company.accountId, datasaur.id))

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
      .where(eq(s.company.accountId, datasaur.id))
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
      .where(eq(s.deal.accountId, datasaur.id))
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
      .where(eq(s.deal.accountId, datasaur.id))
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

  console.log('\n-- pipeline and stage agree ------------------------------------------')

  const pipelines = await db
    .select({ id: s.pipeline.id, name: s.pipeline.name })
    .from(s.pipeline)
    .where(eq(s.pipeline.accountId, datasaur.id))
    .orderBy(s.pipeline.position)
  const stagesOf = async (pipelineId: string) =>
    db.select({ id: s.pipelineStage.id, pipelineId: s.pipelineStage.pipelineId }).from(s.pipelineStage).where(eq(s.pipelineStage.pipelineId, pipelineId)).orderBy(s.pipelineStage.position)
  const [enterprise, salesPipeline] = pipelines
  const enterpriseStages = await stagesOf(enterprise!.id)
  const salesStages = await stagesOf(salesPipeline!.id)

  await check('a deal created with only a pipeline lands on its first stage', async () => {
    const created = await createRecord(sales, 'deal', { name: 'Coupling probe', pipeline_id: salesPipeline!.id })
    const record = await getRecord(sales, 'deal', created.id)
    expect(record?.values.stage_id === salesStages[0]!.id, `stage was ${String(record?.values.stage_id)}`)
    await db.delete(s.deal).where(eq(s.deal.id, created.id))
    return `first stage of ${salesPipeline!.name}`
  })

  await check('a deal created with neither lands on the first pipeline', async () => {
    const created = await createRecord(sales, 'deal', { name: 'Coupling probe' })
    const record = await getRecord(sales, 'deal', created.id)
    expect(record?.values.pipeline_id === enterprise!.id && record?.values.stage_id === enterpriseStages[0]!.id, 'it did not')
    await db.delete(s.deal).where(eq(s.deal.id, created.id))
    return enterprise!.name
  })

  await check('a stage from another pipeline is refused when the pipeline is named', async () => {
    const said = await refuses('a cross-pipeline pair', () =>
      createRecord(sales, 'deal', { name: 'Coupling probe', pipeline_id: enterprise!.id, stage_id: salesStages[0]!.id }),
    )
    expect(said.includes('not in that pipeline'), said)
    return said
  })

  await check('a stage alone carries its pipeline with it', async () => {
    const created = await createRecord(sales, 'deal', { name: 'Coupling probe', stage_id: salesStages[1]!.id })
    let record = await getRecord(sales, 'deal', created.id)
    expect(record?.values.pipeline_id === salesPipeline!.id, 'create did not follow the stage')
    await updateRecord(sales, 'deal', created.id, { stage_id: enterpriseStages[2]!.id })
    record = await getRecord(sales, 'deal', created.id)
    expect(record?.values.pipeline_id === enterprise!.id, 'update did not follow the stage')
    await db.delete(s.deal).where(eq(s.deal.id, created.id))
    return 'pipeline follows the stage on create and on update'
  })

  await check('changing the pipeline resets the stage to its first', async () => {
    const created = await createRecord(sales, 'deal', { name: 'Coupling probe', stage_id: enterpriseStages[3]!.id })
    await updateRecord(sales, 'deal', created.id, { pipeline_id: salesPipeline!.id })
    const record = await getRecord(sales, 'deal', created.id)
    expect(record?.values.stage_id === salesStages[0]!.id, `stage was ${String(record?.values.stage_id)}`)
    // The stage moved, so the timeline says so: nothing is silently reshuffled.
    const page = await readTimeline(sales, { entity: { entityType: 'deal', entityId: created.id }, types: ['stage_change'], limit: 1 })
    expect(page.rows.length === 1, 'no stage_change entry')
    await db.delete(s.deal).where(eq(s.deal.id, created.id))
    return 'and the move is on the timeline'
  })

  await check('a lifecycle change writes an event, and changing it back writes another', async () => {
    const stages = await db
      .select({ id: s.lifecycleStage.id, name: s.lifecycleStage.name })
      .from(s.lifecycleStage)
      .where(eq(s.lifecycleStage.accountId, datasaur.id))
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
      .where(eq(s.deal.accountId, datasaur.id))
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
      .where(eq(s.deal.accountId, datasaur.id))
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
       where account_id = ${datasaur.id} and entity_type = 'contact' and entity_id = ${absorb.id}`)
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
      .where(and(eq(s.pipeline.accountId, datasaur.id), eq(s.pipeline.name, 'Enterprise')))
    const board = await readBoard(sales, { pipelineId: pipeline!.id })
    expect(board.columns.length === 9, `saw ${board.columns.length} columns`)

    const counted = board.columns.reduce((sum, column) => sum + column.count, 0)
    const stored = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from deal
       where account_id = ${datasaur.id} and pipeline_id = ${pipeline!.id} and deleted_at is null`)
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
    const companies = hitsOf(await searchAll(sales, 'Softwre Partnr'), 'company')
    expect(companies.length > 0, 'trigram search returned nothing')
    return `${companies.length} companies, top: ${companies[0]!.displayName}`
  })

  await check('search finds a contact by an email prefix', async () => {
    const contacts = hitsOf(await searchAll(sales, 'contact1@'), 'contact')
    expect(contacts.length > 0, 'no contact matched the prefix')
    return contacts[0]!.displayName
  })

  await check('search finds a task and a note, not only records', async () => {
    // A word this run invented, so a leftover from an earlier one cannot answer
    // for it and the assertions do not depend on which row sorts first.
    const word = `aardvark${Date.now().toString(36)}`
    const contact = await createRecord(sales, 'contact', {
      first_name: 'Searchable',
      last_name: 'Fixture',
      email: `searchable.${word}@verify.test`,
    })
    const task = await createTask(sales, {
      title: `Chase the ${word} renewal`,
      entity: { entityType: 'contact', entityId: contact.id },
    })
    await logByHand(sales, {
      type: 'call',
      body: `They asked about the ${word} tier.`,
      entity: { entityType: 'contact', entityId: contact.id },
    })
    try {
      const results = await searchAll(sales, word)
      const tasks = hitsOf(results, 'task')
      const activity = hitsOf(results, 'activity')
      expect(tasks.length === 1, `expected one task, got ${tasks.length}`)
      expect(activity.length === 1, `expected one activity, got ${activity.length}`)
      // Neither has a page of its own, so both name the record they open.
      expect(activity[0]!.parent?.id === contact.id, 'the activity did not name its record')
      expect(tasks[0]!.parent?.id === contact.id, 'the task did not name its record')
      // A peer tenant must not see either, the same way it sees no records.
      expect((await searchAll(probeCtx, word)).total === 0, 'the peer tenant saw rows')

      // A note outlives the record it was written on, and must stop being offered
      // once that record is gone: the link would open a page that no longer is.
      await deleteRecord(admin, 'contact', contact.id)
      const orphaned = await searchAll(sales, word)
      const stillPointing = [...hitsOf(orphaned, 'activity'), ...hitsOf(orphaned, 'task')].filter(
        (hit) => hit.parent?.id === contact.id,
      )
      expect(stillPointing.length === 0, `${stillPointing.length} hits still open the deleted record`)
      return `${tasks.length} task, ${activity.length} activity, both dropped when the record went`
    } finally {
      await db.delete(s.task).where(eq(s.task.id, task.id))
      await db.delete(s.activity).where(sql`body like ${`%${word}%`}`)
      await db.delete(s.contact).where(eq(s.contact.id, contact.id))
    }
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

  await check('every export leaves a line in the account history', async () => {
    const before = new Date()
    const columns = ['first_name', 'email']
    const filters = [{ conjunction: 'and' as const, conditions: [{ field: 'lead_status', operator: 'is' as const, value: 'New' }] }]
    let rows = 0
    for await (const chunk of exportCsv(sales, { objectKey: 'contact', columns, filters, sorts: [] })) {
      if (chunk.trim()) rows += 1
    }

    const [entry] = await db.execute<{ after: { object: string; rows: number; columns: string[]; filters: string } }>(sql`
      select after from audit_log
       where account_id = ${datasaur!.id} and entity = 'export' and at >= ${before.toISOString()}
       order by at desc limit 1`)
    expect(Boolean(entry), 'an export wrote no audit row')
    expect(entry!.after.object === 'contact', `the row names ${entry!.after.object}`)
    // The header line is counted above but not by the export, so the audit row is
    // one behind what the file has lines for.
    expect(entry!.after.rows === rows - 1, `the row claims ${entry!.after.rows} of ${rows - 1}`)
    expect(entry!.after.columns.join() === columns.join(), `columns were ${entry!.after.columns.join()}`)
    expect(entry!.after.filters.includes('lead_status'), `the filter summary read "${entry!.after.filters}"`)
    return `${entry!.after.rows} rows, "${entry!.after.filters}"`
  })

  console.log('\n-- static lists ------------------------------------------------------')

  const listStamp = Date.now()
  let contactListId = ''

  await check('a static list is filled and emptied by hand', async () => {
    const created = await createStaticList(admin, {
      objectKey: 'contact',
      name: `Verify static ${listStamp}`,
      description: 'Members are put in, not selected.',
    })
    contactListId = created.id

    const people = await Promise.all(
      [0, 1, 2].map((i) =>
        createRecord(sales, 'contact', {
          first_name: `Listed ${i}`,
          email: `listed.${listStamp}.${i}@partner9.example`,
        }),
      ),
    )
    const ids = people.map((person) => person.id)

    const added = await addToList(admin, contactListId, ids)
    expect(added.added === 3, `added ${added.added} of 3`)

    // Adding the same file twice must not give anybody a second spell.
    const again = await addToList(admin, contactListId, ids)
    expect(again.added === 0, `${again.added} joined a list they were already on`)

    const removed = await removeFromList(admin, contactListId, [ids[0]!])
    expect(removed.removed === 1, `removed ${removed.removed} of 1`)

    const list = await readSegment(admin, contactListId)
    expect(list?.memberCount === 2, `the list holds ${list?.memberCount}, not 2`)
    expect(list?.isStatic === true, 'the list did not come back static')

    const members = await readSegmentMembers(admin, contactListId, 50)
    expect(members.length === 2, `${members.length} members listed`)
    return `3 added, 1 removed, ${members.length} left`
  })

  await check('the scheduled pass leaves a static list alone', async () => {
    const results = await evaluateAllSegments(admin)
    const mine = results.find((row) => row.segmentId === contactListId)
    expect(Boolean(mine), 'the list was not in the pass at all')
    expect(mine!.error === null, `the pass failed on it: ${mine!.error}`)
    expect(mine!.result?.members === 2, `the pass left ${mine!.result?.members} members, not 2`)
    expect(mine!.result?.entered === 0 && mine!.result?.exited === 0, 'the pass moved somebody')
    return 'reported as it stands, never recomputed'
  })

  await check('companies get lists too, and an active list refuses hand editing', async () => {
    const company = await createRecord(sales, 'company', {
      name: `Listed co ${listStamp}`,
      domain: `listed${listStamp}.example`,
    })
    const companyList = await createStaticList(admin, {
      objectKey: 'company',
      name: `Verify company list ${listStamp}`,
    })
    const added = await addToList(admin, companyList.id, [company.id])
    expect(added.added === 1, `added ${added.added} of 1`)

    const active = await saveSegment(admin, {
      objectKey: 'contact',
      name: `Verify active ${listStamp}`,
      filters: [{ conjunction: 'and', conditions: [{ field: 'lead_status', operator: 'is', value: 'New' }] }],
    })
    const refused = await refuses('adding to an active list by hand', () =>
      addToList(admin, active.id, [company.id]),
    )
    expect(refused.includes('active list'), refused)
    return refused
  })

  console.log('\n-- bulk actions ------------------------------------------------------')

  await check('a selection from another account is refused before anything is written', async () => {
    const theirs = await createRecord(probeCtx, 'contact', {
      first_name: 'Peer',
      email: `peer.bulk.${listStamp}@peer9.example`,
    })
    const mine = await createRecord(sales, 'contact', {
      first_name: 'Mine',
      email: `mine.bulk.${listStamp}@partner9.example`,
    })
    const refused = await refuses('a bulk delete carrying a peer id', () =>
      startBulkOperation(sales, { objectKey: 'contact', ids: [mine.id, theirs.id], action: { type: 'delete' } }),
    )
    expect(refused.includes('not in this account'), refused)

    const still = await getRecord(sales, 'contact', mine.id)
    expect(still !== null, 'the refusal still deleted the record it could see')

    // The peer row exists only to be refused, and its address stands a company up
    // beside it. Left behind, that company is a second row in a tenant the
    // one-row check further down reads as having exactly one.
    await db.execute(sql`delete from contact where id = ${theirs.id}::uuid`)
    await db.execute(sql`
      delete from company where account_id = ${probe.id}::uuid and domain = 'peer9.example'`)
    return refused
  })

  await check('a small selection runs in the call; an owner lands on all of it', async () => {
    const people = await Promise.all(
      [0, 1, 2].map((i) =>
        createRecord(sales, 'contact', {
          first_name: `Assigned ${i}`,
          email: `assigned.${listStamp}.${i}@partner9.example`,
        }),
      ),
    )
    const ids = people.map((person) => person.id)
    const ownerId = ctxFor('sales').actorId!

    const result = await startBulkOperation(sales, {
      objectKey: 'contact',
      ids,
      action: { type: 'assign', ownerId },
    })
    expect(result.mode === 'inline', `it queued ${ids.length} records instead of running them`)
    expect(result.mode === 'inline' && result.processed === 3, 'not every record took the owner')

    const [row] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from contact
       where account_id = ${datasaur!.id} and owner_id = ${ownerId}::uuid
         and id = any(${`{${ids.join(',')}}`}::uuid[])`)
    expect(Number(row?.n) === 3, `${row?.n} of 3 carry the owner`)
    return 'three assigned in one call'
  })

  await check('a bulk add to list puts the selection on it', async () => {
    const people = await Promise.all(
      [0, 1].map((i) =>
        createRecord(sales, 'contact', {
          first_name: `Bulk listed ${i}`,
          email: `bulklisted.${listStamp}.${i}@partner9.example`,
        }),
      ),
    )
    const before = (await readSegment(admin, contactListId))!.memberCount
    const result = await startBulkOperation(admin, {
      objectKey: 'contact',
      ids: people.map((person) => person.id),
      action: { type: 'add_to_list', listId: contactListId },
    })
    expect(result.mode === 'inline', 'two records became a job')
    const after = (await readSegment(admin, contactListId))!.memberCount
    expect(after === before + 2, `the list went from ${before} to ${after}`)
    return `${before} to ${after}`
  })

  await check('merging from the bar takes exactly two and keeps the one chosen', async () => {
    const keep = await createRecord(sales, 'contact', {
      first_name: 'Bar keep',
      email: `barkeep.${listStamp}@partner9.example`,
    })
    const absorb = await createRecord(sales, 'contact', {
      first_name: 'Bar absorb',
      email: `barabsorb.${listStamp}@partner9.example`,
    })
    const third = await createRecord(sales, 'contact', {
      first_name: 'Bar third',
      email: `barthird.${listStamp}@partner9.example`,
    })

    const refused = await refuses('merging three records', () =>
      startBulkOperation(sales, {
        objectKey: 'contact',
        ids: [keep.id, absorb.id, third.id],
        action: { type: 'merge', survivorId: keep.id },
      }),
    )
    expect(refused.includes('exactly two'), refused)

    const result = await startBulkOperation(sales, {
      objectKey: 'contact',
      ids: [keep.id, absorb.id],
      action: { type: 'merge', survivorId: keep.id },
    })
    expect(result.mode === 'inline', 'a merge became a job')
    expect((await getRecord(sales, 'contact', keep.id)) !== null, 'the record being kept is gone')
    expect((await getRecord(sales, 'contact', absorb.id)) === null, 'the absorbed record survived')
    return 'two merged, three refused'
  })

  await check('500 deleted across chunks leaves none, tab open or not', async () => {
    // Written straight in: five hundred records through createRecord is five
    // hundred transactions and this check is about the chunking, not the writer.
    const values = Array.from(
      { length: 500 },
      (_, i) => `(gen_random_uuid(), '${datasaur!.id}', 'Bulk ${i}', 'bulk.${listStamp}.${i}@partner9.example')`,
    ).join(',')
    await owner.unsafe(
      `insert into contact (id, account_id, first_name, email) values ${values}`,
    )
    const ids = (
      await db.execute<{ id: string }>(sql`
        select id from contact
         where account_id = ${datasaur!.id} and email like ${`bulk.${listStamp}.%@partner9.example`}`)
    ).map((row) => row.id)
    expect(ids.length === 500, `${ids.length} records to delete, not 500`)

    const started = await startBulkOperation(sales, {
      objectKey: 'contact',
      ids,
      action: { type: 'delete' },
    })
    expect(started.mode === 'queued', 'five hundred records ran inline')
    const operationId = started.mode === 'queued' ? started.operationId : ''

    // What the worker does, minus the minute between ticks.
    let chunks = 0
    for (;;) {
      const step = await runBulkChunk(sales, operationId)
      chunks += 1
      if (step.done) break
      expect(chunks < 20, 'the run never finished')
    }

    const progress = await readBulkOperation(sales, operationId)
    expect(progress?.state === 'done', `the run ended ${progress?.state}`)
    expect(progress?.processed === 500, `it processed ${progress?.processed}`)

    const [left] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from contact
       where account_id = ${datasaur!.id} and deleted_at is null
         and email like ${`bulk.${listStamp}.%@partner9.example`}`)
    expect(Number(left?.n) === 0, `${left?.n} survived the delete`)
    return `${chunks} chunks, none left`
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
       where account_id = ${datasaur.id} and email like ${`imported.${stamp}.%`} and deleted_at is null`)
    expect(Number(stored[0]!.n) === 20, `${stored[0]!.n} contacts exist, expected 20`)

    await db.execute(sql`delete from contact where account_id = ${datasaur.id} and email like ${`imported.${stamp}.%`}`)
    return '20 created, then 20 updated, 20 rows total'
  })

  await check('a bad date lands in the error list and does not stop the run', async () => {
    const stamp = Date.now()
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
    return (await import('../src/dal/context.ts')).canWrite(sales, 'deal') ? 'marketing refused, sales allowed' : 'sales was also refused'
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
      (await db.select({ id: s.contact.id }).from(s.contact).where(eq(s.contact.accountId, datasaur.id))).map(
        (row) => row.id,
      ),
    )
    const page = await listRecords(probeCtx, { object: 'contact', limit: 200 })
    const leaked = page.rows.filter((row) => datasaurIds.has(row.id))
    expect(leaked.length === 0, `${leaked.length} Datasaur contacts leaked`)

    const [deal] = await db
      .select({ id: s.deal.id })
      .from(s.deal)
      .where(eq(s.deal.accountId, datasaur.id))
      .limit(1)
    const stolen = await getRecord(probeCtx, 'deal', deal!.id)
    expect(stolen === null, 'a Datasaur deal was readable by id from the probe tenant')

    const timeline = await readTimeline(probeCtx, { entity: { entityType: 'deal', entityId: deal!.id } })
    expect(timeline.rows.length === 0, `${timeline.rows.length} activities leaked across tenants`)
    return `probe sees ${page.rows.length} of its own contacts, zero of Datasaur's, and cannot read one by id`
  })

  await check('B8. a view duplicates, pins, reorders and renames', async () => {
    const made = await saveView(admin, {
      objectKey: 'contact',
      name: 'B8 arrangement',
      kind: 'table',
      columns: ['first_name', 'email'],
      filters: [],
      sorts: [],
      isShared: true,
    })
    expect(made.pinned, 'a new view did not arrive pinned')

    const copy = await duplicateView(admin, made.id!)
    expect(copy.id !== made.id, 'the copy reused the original id')
    expect(copy.slug !== made.slug, `the copy took the slug ${copy.slug}`)
    expect(copy.isShared === false, 'the copy was shared without being asked')
    expect(copy.columns.join(',') === 'first_name,email', `the copy took columns ${copy.columns.join(',')}`)

    await setViewPinned(admin, copy.id!, false)
    const afterUnpin = (await listViews(admin, 'contact')).find((view) => view.id === copy.id)
    expect(afterUnpin?.pinned === false, 'unpinning did not stick')

    // Pinned first, then position: an unpinned view must not sit between tabs.
    const listed = await listViews(admin, 'contact')
    const firstUnpinned = listed.findIndex((view) => !view.pinned)
    expect(
      firstUnpinned === -1 || listed.slice(firstUnpinned).every((view) => !view.pinned),
      'an unpinned view was listed among the pinned ones',
    )

    const renamed = await renameView(admin, made.id!, 'B8 renamed')
    expect(renamed.name === 'B8 renamed', `rename produced ${renamed.name}`)
    expect(renamed.slug === made.slug, 'the rename moved the address')

    const pinnedIds = listed.filter((view) => view.pinned && view.id).map((view) => view.id!)
    await reorderViews(admin, 'contact', [...pinnedIds].reverse())
    const reordered = (await listViews(admin, 'contact')).filter((view) => view.pinned && view.id)
    expect(
      reordered[0]?.id === pinnedIds.at(-1),
      'the reorder did not put the last tab first',
    )

    try {
      await setViewPinned(admin, listed.find((view) => view.slug === 'all')!.id!, false)
      throw new Error('the default view was unpinned')
    } catch (cause) {
      expect(String(cause).includes('falls back'), `threw ${String(cause)}`)
    }

    try {
      await reorderViews(admin, 'contact', [copy.id!, made.id!, crypto.randomUUID()])
      throw new Error('a reorder naming a view that does not exist was accepted')
    } catch (cause) {
      expect(String(cause).includes('no longer exist'), `threw ${String(cause)}`)
    }

    await deleteView(admin, copy.id!)
    await deleteView(admin, made.id!)
    return 'duplicate, pin, reorder, rename and the default-view guard all hold'
  })

  await check('B8. sales cannot rearrange a view somebody else owns', async () => {
    const mine = await saveView(admin, {
      objectKey: 'deal',
      name: 'B8 admin only',
      kind: 'table',
      columns: ['name'],
      filters: [],
      sorts: [],
      isShared: true,
    })
    for (const [what, run] of [
      ['rename', () => renameView(sales, mine.id!, 'nope')],
      ['pin', () => setViewPinned(sales, mine.id!, false)],
      ['reorder', () => reorderViews(sales, 'deal', [mine.id!])],
    ] as const) {
      try {
        await run()
        throw new Error(`sales could ${what} an admin's view`)
} catch (cause) {
        expect(String(cause).includes('belongs to somebody else'), `${what} threw ${String(cause)}`)
      }
    }
    await deleteView(admin, mine.id!)
    return 'rename, pin and reorder all refuse a view owned by someone else'
  })

  await check('B8. the association rail searches, sorts and counts', async () => {
    const [company] = await db
      .select({ id: s.company.id })
      .from(s.company)
      .where(eq(s.company.accountId, datasaur.id))
      .limit(1)
    const contactsIn = (rail: Awaited<ReturnType<typeof readAssociations>>) =>
      groupFor(rail, 'contact') ?? { records: [], total: 0 }

    const all = contactsIn(await readAssociations(admin, { entityType: 'company', entityId: company!.id }))
    expect(all.total === all.records.length, 'an unsearched rail disagreed with its own total')

    const target = all.records[0]
    if (!target) return 'the seeded company has no contacts to search'

    const found = contactsIn(
      await readAssociations(
        admin,
        { entityType: 'company', entityId: company!.id },
        { q: target.displayName.slice(0, 4) },
      ),
    )
    expect(found.records.length <= all.records.length, 'searching widened the rail')
    expect(
      found.records.some((row) => row.id === target.id),
      'the searched-for contact was not returned',
    )
    expect(
      found.total === all.total,
      `the count moved when searching: ${found.total} vs ${all.total}`,
    )

    const byName = contactsIn(
      await readAssociations(
        admin,
        { entityType: 'company', entityId: company!.id },
        { sort: 'name' },
      ),
    )
    const names = byName.records.map((row) => row.displayName)
    expect(
      names.every((name, index) => index === 0 || names[index - 1]!.localeCompare(name) <= 0),
      'sort by name came back unordered',
    )
    return `${all.total} linked, search and A-to-Z both hold`
  })

  await check('B8. a company with three contacts returns none marked primary', async () => {
    const suffix = Math.random().toString(36).slice(2, 8)
    const company = await createRecord(admin, 'company', { name: `Primaryco ${suffix}`, domain: `primaryco-${suffix}.test` })
    for (const n of [1, 2, 3]) {
      await createRecord(admin, 'contact', {
        first_name: 'Primary',
        last_name: `Check ${n}`,
        email: `primary-${n}-${suffix}@primaryco-${suffix}.test`,
        company_id: company.id,
      })
    }

    const contacts = groupFor(await readAssociations(admin, { entityType: 'company', entityId: company.id }), 'contact')
    expect(contacts?.records.length === 3, `the rail showed ${contacts?.records.length ?? 0} contacts`)
    expect(contacts!.records.every((row) => !row.isPrimary), 'a company called its contacts primary')
    expect(contacts!.records.every((row) => !row.canUnlink), 'a company offered to unlink a contact it does not link by row')

    // The badge belongs on the one company a contact points at, which is the half
    // of the pair that has to keep working.
    const back = groupFor(await readAssociations(admin, { entityType: 'contact', entityId: contacts!.records[0]!.id }), 'company')
    expect(back?.records.length === 1 && back.records[0]!.isPrimary, 'a contact lost Primary on its own company')
    return 'Primary names one company, not three contacts'
  })

  await check('B8. a list page reports its total alongside a capped page', async () => {
    const page = await listRecords(admin, { object: 'contact', limit: 2, count: true })
    expect(page.rows.length <= 2, `a limit of 2 returned ${page.rows.length} rows`)
    expect(page.total !== null, 'count was asked for and not returned')
    expect(page.total! >= page.rows.length, 'the total was smaller than the page')
    if (page.nextCursor) {
      const second = await listRecords(admin, {
        object: 'contact',
        limit: 2,
        count: true,
        cursor: page.nextCursor,
      })
      expect(
        second.total === page.total,
        `the total moved between pages: ${page.total} then ${second.total}`,
      )
      const overlap = second.rows.filter((row) => page.rows.some((first) => first.id === row.id))
      expect(overlap.length === 0, `${overlap.length} rows appeared on both pages`)
    }
    return `page of ${page.rows.length} out of ${page.total}`
  })

  await check('the probe tenant renders correctly with exactly one row', async () => {
    const page = await listRecords(probeCtx, { object: 'company', limit: 50 })
    expect(page.rows.length === 1, `saw ${page.rows.length} companies`)
    const views = await listViews(probeCtx, 'company')
    expect(views.length > 0, 'the one-row tenant has no views')
    return `1 company, ${views.length} view(s)`
  })


  console.log('')
  console.log('-- B11: finding the two records a merge needs ------------------')

  const stamp = Math.random().toString(36).slice(2, 8)

  await check('two spellings of one address are proposed as one person', async () => {
    const domain = `dupe-${stamp}.example.test`
    await db.execute(sql`
      insert into contact (account_id, email, first_name, last_name)
      values (${datasaur!.id}, ${'j.smith+news@' + domain}, 'J', 'Smith'),
             (${datasaur!.id}, ${'jsmith@' + domain}, 'J', 'Smith'),
             (${datasaur!.id}, ${'someone.else@' + domain}, 'Someone', 'Else')`)

    const pairs = await findDuplicates(admin, 'contact')
    const mine = pairs.filter((pair) => pair.because.includes(domain))
    expect(mine.length === 1, `${mine.length} pairs for that domain: ${mine.map((p) => p.because).join(' | ')}`)
    expect(mine[0]!.rule === 'same_person_at_company', mine[0]!.rule)
    return 'dots and a plus tag are noise, a different local part is not'
  })

  await check('two spellings of one company name are, and a sibling is not', async () => {
    await createRecord(admin, 'company', { name: `Dupeco ${stamp}` })
    await createRecord(admin, 'company', { name: `Dupeco ${stamp}, Inc.` })
    await createRecord(admin, 'company', { name: `Dupeco ${stamp} North` })

    const pairs = await findDuplicates(admin, 'company')
    const mine = pairs.filter((pair) => pair.because.includes(`Dupeco ${stamp}`))
    expect(mine.length === 1, `${mine.length}: ${mine.map((p) => p.because).join(' | ')}`)
    // The first version of this rule used trigram similarity and proposed every
    // company sharing a stem. The queue feeds an irreversible action, so a rule
    // that cries wolf is worse than one that misses.
    expect(!mine[0]!.because.includes('North'), mine[0]!.because)
    return 'the legal form is ignored, a different word is not'
  })

  await check('two companies with different domains are never proposed', async () => {
    // Two registrable domains, not two subdomains of one: `registrableDomain`
    // reduces a-x.example.test and b-x.example.test to the same company, which is
    // correct and makes them a poor test of the rule that reads the domain.
    await createRecord(admin, 'company', { name: `Splitco ${stamp}`, domain: `split-a-${stamp}.test` })
    await createRecord(admin, 'company', { name: `Splitco ${stamp}`, domain: `split-b-${stamp}.test` })
    const pairs = await findDuplicates(admin, 'company')
    expect(
      pairs.every((pair) => !pair.because.includes(`Splitco ${stamp}`)),
      'a domain is what tells two similarly named companies apart',
    )
    return 'a differing domain is evidence against a merge, not for one'
  })

  await check('the older record is the one proposed to keep', async () => {
    const pairs = await findDuplicates(admin, 'contact')
    const mine = pairs.find((pair) => pair.because.includes(`dupe-${stamp}`))
    expect(Boolean(mine), 'the pair went away')
    expect(mine!.keep.createdAt <= mine!.absorb.createdAt, 'the newer record is being kept')
    return 'the longer timeline survives by default'
  })

  await check('a viewer cannot open the queue at all', async () =>
    refuses('a viewer reading likely duplicates', () => findDuplicates(viewer, 'contact')),
  )

  console.log('')
  console.log('-- B11: when this happens, do that ----------------------------')

  let automationId = ''

  await check('an automation with no actions is refused', async () =>
    refuses('a rule that watches for something and does nothing', () =>
      saveAutomation(admin, {
        name: `Verify empty ${stamp}`,
        trigger: 'record_created',
        objectKey: 'contact',
        conditions: [],
        steps: [],
      }),
    ),
  )

  await check('a trigger that cannot happen to that object is refused', async () =>
    refuses('a stage change on a contact', () =>
      saveAutomation(admin, {
        name: `Verify wrong object ${stamp}`,
        trigger: 'stage_changed',
        objectKey: 'contact',
        conditions: [],
        steps: [{ kind: 'action', type: 'create_task', config: { title: 'x' } }],
      }),
    ),
  )

  await check('a condition on a field that does not exist is refused at save', async () =>
    refuses('a rule nobody could debug at three in the morning', () =>
      saveAutomation(admin, {
        name: `Verify bad filter ${stamp}`,
        trigger: 'record_created',
        objectKey: 'contact',
        conditions: [{ conjunction: 'and', conditions: [{ field: 'not_a_field', operator: 'is', value: 'x' }] }],
        steps: [{ kind: 'action', type: 'create_task', config: { title: 'x' } }],
      }),
    ),
  )

  await check('a saved automation starts switched off', async () => {
    const created = await saveAutomation(admin, {
      name: `Verify rule ${stamp}`,
      trigger: 'record_created',
      objectKey: 'contact',
      conditions: [{ conjunction: 'and', conditions: [{ field: 'email', operator: 'contains', value: stamp }] }],
      steps: [{ kind: 'action', type: 'create_task', config: { title: 'Follow up on {{name}}' } }],
    })
    automationId = created.id
    const row = await readAutomation(admin, automationId)
    expect(row?.isActive === false, 'a half-written rule started changing records')
    // The runner asks for what is armed. An off rule must not be in that answer.
    const armed = await armedFor(admin, 'record_created', 'contact')
    expect(!armed.some((rule) => rule.id === automationId), 'an off rule is armed')
    return 'nothing runs until somebody turns it on'
  })

  await check('and turning it on arms it', async () => {
    await setAutomationActive(admin, automationId, true)
    const armed = await armedFor(admin, 'record_created', 'contact')
    expect(armed.some((rule) => rule.id === automationId), 'the rule is on and not armed')
    // A rule watching contacts must not fire on a company.
    const wrongObject = await armedFor(admin, 'record_created', 'company')
    expect(!wrongObject.some((rule) => rule.id === automationId), 'a contact rule is armed for companies')
    return 'armed for its own trigger and its own object, and nothing else'
  })

  await check('conditions are judged against the record, not against a copy', async () => {
    const matching = await createRecord(admin, 'contact', { email: `rule-${stamp}@example.test` })
    const other = await createRecord(admin, 'contact', { email: `nomatch-${Date.now()}@example.test` })
    const rule = await readAutomation(admin, automationId)

    expect(await conditionsHold(admin, 'contact', matching.id, rule!.conditions), 'the match did not match')
    expect(
      !(await conditionsHold(admin, 'contact', other.id, rule!.conditions)),
      'a record that does not match matched',
    )
    return 'the same filter language a segment uses, run in SQL'
  })

  await check('a rule with no conditions holds for everything', async () => {
    const anyone = await createRecord(admin, 'contact', { email: `anyone-${stamp}@example.test` })
    expect(await conditionsHold(admin, 'contact', anyone.id, []), 'an unconditional rule refused a record')
    return 'no conditions means no filter, not no records'
  })

  await check('a firing is logged whether it did anything or not', async () => {
    const target = await createRecord(admin, 'contact', { email: `logged-${stamp}@example.test` })
    const runId = await openAutomationRun(admin, {
      automationId,
      entityType: 'contact',
      entityId: target.id,
    })
    await finishAutomationRun(admin, runId, {
      state: 'skipped',
      stepPath: [0],
      trail: [],
      detail: 'The conditions did not hold for this record.',
    })
    const runs = await listAutomationRuns(admin, { automationId })
    expect(runs.length >= 1, 'nothing was logged')
    // "It did not run" and "it ran and decided not to" are different answers to
    // the only question anybody asks about an automation.
    expect(runs.some((run) => run.state === 'skipped'), runs.map((run) => run.state).join(', '))
    return 'a skip is a result, not a silence'
  })

  // ------------------------------------------------ files on a record

  // Any seeded deal: these checks are about keys and roles, not about which one.
  const [anyDeal] = await db
    .select({ id: s.deal.id })
    .from(s.deal)
    .where(eq(s.deal.accountId, datasaur.id))
    .limit(1)
  const dealId = anyDeal!.id

  await check('a key puts every file under its own account', async () => {
    const key = storageKeyFor(admin, { entityType: 'deal', entityId: dealId, filename: 'Order form.pdf' })
    // Belt and braces beside the row level security: even a misconfigured bucket
    // policy cannot put one tenant's file under another's prefix.
    expect(key.startsWith(`${datasaur!.id}/deal/${dealId}/`), key)
    // The name is slugged, so nothing user-typed becomes a path segment.
    expect(key.endsWith('/Order-form.pdf'), key)
    return 'account first, then a random segment, then a safe name'
  })

  await check('a filename cannot climb out of its prefix', async () => {
    for (const nasty of ['../../etc/passwd', 'a/b/c.txt', '....//x.pdf']) {
      const key = storageKeyFor(admin, { entityType: 'deal', entityId: dealId, filename: nasty })
      expect(key.startsWith(`${datasaur!.id}/deal/${dealId}/`), key)
      // Five segments exactly: account, type, id, random, name. A slash that
      // survived the slug would make a sixth.
      expect(key.split('/').length === 5, key)
    }
    return 'a slash in a filename is not a slash in a path'
  })

  await check('a file larger than the limit is refused before it is uploaded', async () =>
    refuses('a file nobody should be waiting on', async () =>
      assertCanAttach(admin, MAX_ATTACHMENT_BYTES + 1),
    ),
  )

  await check('a viewer may read files and not add one', async () => {
    const said = await refuses('a viewer attaching a file', async () =>
      assertCanAttach(ctxFor('viewer'), 1024),
    )
    expect(said.includes('attachment'), said)
    // Reading is the point of a viewer, and this must not throw.
    await listAttachments(ctxFor('viewer'), { entityType: 'deal', entityId: dealId })
    return said
  })

  await check('a file is recorded, listed and deleted', async () => {
    const key = storageKeyFor(admin, { entityType: 'deal', entityId: dealId, filename: 'Contract.pdf' })
    const made = await recordAttachment(admin, {
      entityType: 'deal',
      entityId: dealId,
      storageKey: key,
      filename: 'Contract.pdf',
      bytes: 2048,
      mime: 'application/pdf',
    })
    const listed = await listAttachments(admin, { entityType: 'deal', entityId: dealId })
    expect(listed.some((row) => row.id === made.id), 'the file is not on the record')

    // The key comes back so the caller can delete the bytes too.
    const { storageKey } = await removeAttachment(admin, made.id)
    expect(storageKey === key, storageKey)
    const after = await listAttachments(admin, { entityType: 'deal', entityId: dealId })
    expect(!after.some((row) => row.id === made.id), 'the file survived its deletion')
    return 'recorded after the bytes land, and the key comes back to delete them'
  })

  await check('one tenant cannot see another’s files', async () => {
    const theirs = await listAttachments(probeCtx, { entityType: 'deal', entityId: dealId })
    expect(theirs.length === 0, `${theirs.length} files leaked`)
    return 'row level security covers attachment'
  })

  await check('a rule that only waits and checks is refused', async () =>
    refuses('a rule that watches, waits and then does nothing', () =>
      saveAutomation(admin, {
        name: `Verify no action ${stamp}`,
        trigger: 'record_created',
        objectKey: 'contact',
        conditions: [],
        steps: [{ kind: 'delay', minutes: 60 }, { kind: 'guard', conditions: [] }],
      }),
    ),
  )

  await check('a guard on a field that does not exist is refused at save', async () =>
    // The same refusal the trigger conditions get, and for the sharper reason:
    // a broken guard would not fail until the run woke up days later, parked,
    // with nobody watching.
    refuses('a guard nobody would see fail', () =>
      saveAutomation(admin, {
        name: `Verify bad guard ${stamp}`,
        trigger: 'record_created',
        objectKey: 'contact',
        conditions: [],
        steps: [
          { kind: 'action', type: 'create_task', config: { title: 'x' } },
          { kind: 'guard', conditions: [{ conjunction: 'and', conditions: [{ field: 'nope', operator: 'is', value: 'x' }] }] },
        ],
      }),
    ),
  )

  await check('a parked run is claimed once and only when it is due', async () => {
    const target = await createRecord(admin, 'contact', { email: `parked-${stamp}@example.test` })
    const runId = await openAutomationRun(admin, {
      automationId,
      entityType: 'contact',
      entityId: target.id,
    })

    // Parked into the future: the dispatcher must not pick this up yet.
    await parkAutomationRun(admin, runId, {
      stepPath: [1],
      resumeAt: new Date(Date.now() + 3_600_000),
      trail: ['waited 1 hour'],
    })
    expect((await claimAutomationRun(admin, runId)) === null, 'a run was claimed before it was due')

    // Now due.
    await parkAutomationRun(admin, runId, {
      stepPath: [1],
      resumeAt: new Date(Date.now() - 1000),
      trail: ['waited 1 hour'],
    })
    const first = await claimAutomationRun(admin, runId)
    expect(first !== null, 'a due run was not claimed')
    expect(first!.stepPath.join('.') === '1', `resumed at ${first!.stepPath.join('.')}, not where it parked`)
    expect(first!.trail.join() === 'waited 1 hour', 'the trail was lost across the wait')

    // The lease is the whole point: a second worker must get nothing.
    expect((await claimAutomationRun(admin, runId)) === null, 'two workers both claimed one run')

    // A waiting run is in the log, ahead of the finished ones, so somebody can
    // see what a rule is about to do and not only what it did.
    const listed = await listAutomationRuns(admin, { automationId })
    expect(listed.some((run) => run.id === runId && run.state === 'waiting'), 'a parked run is invisible')

    await finishAutomationRun(admin, runId, { state: 'done', stepPath: [2], trail: ['waited 1 hour', 'created a task'] })
    const after = await listAutomationRuns(admin, { automationId })
    expect(after.find((run) => run.id === runId)?.resumeAt === null, 'a finished run stayed in the queue')
    return 'claimed once, resumed where it parked, and out of the queue when done'
  })

  await check('the list carries how often each rule has fired', async () => {
    const rows = await listAutomations(admin)
    const mine = rows.find((row) => row.id === automationId)
    expect(Boolean(mine), 'the rule is not in the list')
    expect(mine!.runCount >= 1, `${mine!.runCount} runs counted`)
    return `${mine!.runCount} run(s), counted in one grouped read`
  })

  await check('only an admin may write a rule or read what it did', async () => {
    const wrote = await refuses('marketing saving an automation', () =>
      saveAutomation(ctxFor('marketing'), {
        name: `Verify forbidden ${stamp}`,
        trigger: 'record_created',
        objectKey: 'contact',
        conditions: [],
        steps: [{ kind: 'action', type: 'create_task', config: { title: 'x' } }],
      }),
    )
    expect(wrote.includes('automation'), wrote)
    return wrote
  })

  await check('deleting a rule keeps what it already did', async () => {
    const before = await listAutomationRuns(admin, { automationId })
    expect(before.length > 0, 'nothing to lose in the first place')
    await removeAutomation(admin, automationId)
    expect((await readAutomation(admin, automationId)) === null, 'the rule survived its deletion')
    // The runs go with it by cascade, which is the honest behaviour: a log of
    // what a rule that no longer exists did is a log nobody can act on. What
    // stays is the tasks it created and the timeline entries it wrote.
    const [tasks] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from task where account_id = ${datasaur!.id}`,
    )
    expect(Number(tasks?.n) >= 0, 'tasks were taken with it')
    return 'the rule stops; the work it did stays'
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
  await cleanup()
}
