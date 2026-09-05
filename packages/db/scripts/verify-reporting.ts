import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as s from '../src/schema/index.ts'
import type { Role, WorkspaceContext } from '../src/dal/context.ts'
import { attributionReport, clampRange, pipelineReport, websiteReport, MAX_DAYS } from '../src/dal/reporting.ts'
import { backfillVisitor } from '../src/dal/stitch.ts'
import { collect, publicSite } from '../src/dal/collect.ts'
import { createSite } from '../src/dal/analytics.ts'
import { createRecord } from '../src/dal/records.ts'
import {
  deleteReportDashboard,
  listReportDashboards,
  readReportDashboard,
  saveReportDashboard,
} from '../src/dal/report-dashboards.ts'
import { closeAppPool } from '../src/internal/pool.ts'

/** B7 against the real database.
 *
 *  The pure channel rules are unit tested. What is checked here is everything a
 *  unit test cannot see: that a visit is labelled once and stored, that a first
 *  touch only ever moves backwards in time, that a later visit updates the last
 *  touch without disturbing the first, that the numbers add up to the same total
 *  read two different ways, and that none of it crosses a tenant boundary. */

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
    pass(what, (await fn()) ?? '')
  } catch (cause) {
    fail(what, cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause))
  }
}

const expect = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
}

const stamp = Math.random().toString(36).slice(2, 8)
const DAY = 86_400_000

try {
  const [datasaur] = await db.select().from(s.workspace).where(eq(s.workspace.slug, 'datasaur'))
  const [probe] = await db.select().from(s.workspace).where(eq(s.workspace.slug, 'probe'))
  if (!datasaur || !probe) throw new Error('Run pnpm db:seed first.')

  const members = await db
    .select({ id: s.userAccount.id, role: s.membership.role })
    .from(s.membership)
    .innerJoin(s.userAccount, eq(s.userAccount.id, s.membership.userId))
    .where(eq(s.membership.workspaceId, datasaur.id))

  const ctxFor = (role: Role): WorkspaceContext => {
    const member = members.find((m) => m.role === role)
    if (!member) throw new Error(`no seeded ${role}`)
    return { workspaceId: datasaur.id, actorId: member.id, actorKind: 'user', role }
  }

  const admin = ctxFor('admin')
  const viewer = ctxFor('viewer')
  const probeCtx: WorkspaceContext = { workspaceId: probe.id, actorId: null, actorKind: 'user', role: 'admin' }
  const wide = clampRange({ from: new Date(Date.now() - 300 * DAY), to: new Date(Date.now() + DAY) })

  console.log('-- the range -----------------------------------------------------')

  await check('a range nobody asked for is the last thirty days', async () => {
    const range = clampRange({})
    expect(Math.round((range.to.getTime() - range.from.getTime()) / DAY) === 29, 'not 30 days')
    return 'a report opens on something answerable'
  })

  await check('no range can ask for the whole table', async () => {
    const range = clampRange({ from: '1970-01-01T00:00:00Z', to: new Date().toISOString() })
    expect(Math.round((range.to.getTime() - range.from.getTime()) / DAY) === MAX_DAYS, 'not capped')
    return `capped at ${MAX_DAYS} days, whatever the URL says`
  })

  console.log('')
  console.log('-- a visit is labelled once, on its first page --------------------')

  const siteKey = `reporting-${stamp}`
  await createSite(admin, { name: `Reporting ${stamp}`, host: `${siteKey}.example`, siteKey })
  const publicised = await publicSite(siteKey)
  if (!publicised) throw new Error('the tracked site is not public')

  const visitorId = `${stamp}reporting00000000000`

  await check('a paid click is stored as Paid Search, not read off the referrer', async () => {
    await collect({
      site: publicised,
      visitorId,
      url: `https://${siteKey}.example/pricing?gclid=paid-${stamp}`,
      path: '/pricing',
      title: 'Pricing',
      // Google referred the visit, so a referrer-only rule would call it Organic.
      referrer: 'https://www.google.com/',
      utm: { gclid: `paid-${stamp}` },
      at: new Date(Date.now() - 10 * DAY),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    })

    const [session] = await db.execute<{ channel: string | null }>(
      sql`select channel from visitor_session
           where workspace_id = ${datasaur.id} and visitor_id = ${visitorId}
           order by started_at limit 1`,
    )
    expect(session?.channel === 'Paid Search', `stored as ${session?.channel}`)
    return 'the click id wins over the referrer'
  })

  await check('a second page does not relabel the visit', async () => {
    await collect({
      site: publicised,
      visitorId,
      url: `https://${siteKey}.example/docs`,
      path: '/docs',
      title: 'Docs',
      // The internal referrer of the page before it, which a per-page rule would
      // turn into a self-referral.
      referrer: `https://${siteKey}.example/pricing`,
      utm: {},
      at: new Date(Date.now() - 10 * DAY + 60_000),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    })

    const rows = await db.execute<{ channel: string | null }>(
      sql`select channel from visitor_session
           where workspace_id = ${datasaur.id} and visitor_id = ${visitorId}`,
    )
    expect(rows.length === 1, `${rows.length} sessions, expected one`)
    expect(rows[0]?.channel === 'Paid Search', `relabelled to ${rows[0]?.channel}`)
    return 'one visit, one channel, decided on the first page'
  })

  console.log('')
  console.log('-- first touch moves earlier, and only earlier --------------------')

  let contactId = ''

  await check('a contact created later gets the earlier visit as its first touch', async () => {
    // Created now, with the source a form fill would have written: Direct.
    const created = await createRecord(admin, 'contact', {
      first_name: 'Verify',
      last_name: 'Attribution',
      email: `verify-attr-${stamp}@partner1.example`,
    })
    contactId = created.id
    await db.execute(sql`
      update contact
         set original_source = ${JSON.stringify({
           channel: 'Direct Traffic',
           detail: { firstSeenAt: new Date().toISOString() },
         })}::jsonb,
             latest_source = ${JSON.stringify({ channel: 'Direct Traffic', detail: {} })}::jsonb
       where id = ${contactId}`)

    await db.execute(sql`
      update visitor set contact_id = ${contactId}
       where workspace_id = ${datasaur.id} and id = ${visitorId}`)
    await backfillVisitor(admin, { visitorId, contactId })

    const [row] = await db.execute<{ channel: string; at: string }>(sql`
      select original_source ->> 'channel' as channel,
             original_source #>> '{detail,firstSeenAt}' as at
        from contact where id = ${contactId}`)
    expect(row?.channel === 'Paid Search', `first touch is ${row?.channel}`)
    return 'the ad that found them in the past beats the form that named them today'
  })

  await check('and running the back-fill again changes nothing', async () => {
    const [before] = await db.execute<{ source: string }>(
      sql`select original_source::text as source from contact where id = ${contactId}`,
    )
    await backfillVisitor(admin, { visitorId, contactId })
    const [after] = await db.execute<{ source: string }>(
      sql`select original_source::text as source from contact where id = ${contactId}`,
    )
    expect(before?.source === after?.source, 'the first touch moved on a re-run')
    return 'idempotent, because the guard is on the stored timestamp'
  })

  await check('a later visit updates the last touch and leaves the first alone', async () => {
    const [before] = await db.execute<{ source: string }>(
      sql`select original_source::text as source from contact where id = ${contactId}`,
    )

    await collect({
      site: publicised,
      visitorId,
      url: `https://${siteKey}.example/blog`,
      path: '/blog',
      title: 'Blog',
      referrer: 'https://www.linkedin.com/feed/',
      utm: {},
      // Well past the thirty-minute gap, so this is a new session.
      at: new Date(),
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    })

    const [row] = await db.execute<{ first: string; last: string | null }>(sql`
      select original_source::text as first, latest_source ->> 'channel' as last
        from contact where id = ${contactId}`)
    expect(row?.last === 'Social Media', `last touch is ${row?.last}`)
    expect(row?.first === before?.source, 'the first touch moved when a later visit arrived')
    return 'last touch moves, first touch does not'
  })

  console.log('')
  console.log('-- the numbers reconcile -----------------------------------------')

  await check('the website report counts the same visits the table holds', async () => {
    const report = await websiteReport(admin, wide)
    const [counted] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from visitor_session
       where workspace_id = ${datasaur.id}
         and started_at >= ${wide.from.toISOString()}::timestamptz
         and started_at < ${wide.to.toISOString()}::timestamptz`)
    expect(
      report.identifiedShare.sessions === Number(counted?.n),
      `${report.identifiedShare.sessions} in the report, ${counted?.n} in the table`,
    )
    return `${report.identifiedShare.sessions} visits, ${report.identifiedShare.identified} of them named`
  })

  await check('an unattributed contact is shown rather than dropped', async () => {
    // A contact with no source at all: an import, or somebody typed in by hand.
    await createRecord(admin, 'contact', {
      first_name: 'Verify',
      last_name: 'Unattributed',
      email: `verify-unattr-${stamp}@partner2.example`,
    })
    const report = await attributionReport(admin, wide)
    const bucket = report.first.find((row) => row.channel === 'Not attributed')
    expect(Boolean(bucket && bucket.contacts > 0), 'the unattributed bucket is missing or empty')
    return 'a report that quietly excludes contacts is worse than one that admits it'
  })

  await check('both touches are reported, and neither is blended into the other', async () => {
    const report = await attributionReport(admin, wide)
    const firstPaid = report.first.find((row) => row.channel === 'Paid Search')
    const lastSocial = report.last.find((row) => row.channel === 'Social Media')
    expect(Boolean(firstPaid), 'Paid Search is missing from first touch')
    expect(Boolean(lastSocial), 'Social Media is missing from last touch')
    return 'one contact appears under the ad that found them and the post that brought them back'
  })

  await check('the pipeline report groups without reading the table into memory', async () => {
    const report = await pipelineReport(admin, wide)
    expect(report.weeks.length <= 200, `${report.weeks.length} weeks`)
    expect(report.funnel.length <= 200, `${report.funnel.length} stages`)
    const created = report.weeks.reduce((total, week) => total + week.created, 0)
    const [counted] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from deal
       where workspace_id = ${datasaur.id} and deleted_at is null
         and created_at >= ${wide.from.toISOString()}::timestamptz
         and created_at < ${wide.to.toISOString()}::timestamptz`)
    expect(created === Number(counted?.n), `${created} in the report, ${counted?.n} in the table`)
    return `${created} deals, reconciled against the table`
  })

  console.log('')
  console.log('-- who may read it, and whose numbers they are -------------------')

  await check('a viewer may read a report', async () => {
    const report = await websiteReport(viewer, wide)
    expect(report.identifiedShare.sessions >= 0, 'a viewer was refused')
    return 'aggregate numbers about work a viewer can already see one record at a time'
  })

  await check('one tenant never sees another’s numbers', async () => {
    const report = await websiteReport(probeCtx, wide)
    const mine = report.channels.find((row) => row.channel === 'Paid Search')
    const [counted] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from visitor_session
       where workspace_id = ${probe.id} and channel = 'Paid Search'`)
    expect(
      (mine?.sessions ?? 0) === Number(counted?.n),
      `probe sees ${mine?.sessions ?? 0}, its own table holds ${counted?.n}`,
    )
    return 'row level security, not a where clause somebody has to remember'
  })

  console.log('')
  console.log('-- B11: reports somebody assembled -------------------------------')

  let dashboardId = ''

  await check('a dashboard with no cards is refused', async () => {
    try {
      await saveReportDashboard(admin, { name: `Empty ${stamp}`, cards: [], isShared: false })
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
    throw new Error('a blank page was saved as a dashboard')
  })

  await check('a viewer may build one', async () => {
    // Deliberately the widest write role in the product. A dashboard shows no
    // figure the six reports do not already show a viewer, and the person who
    // most wants four numbers on one screen is usually the one who only reads.
    const created = await saveReportDashboard(viewer, {
      name: `Viewer ${stamp}`,
      cards: ['deals_created', 'form_fills'],
      isShared: false,
    })
    await deleteReportDashboard(viewer, created.id)
    return 'arranging what you can already read is not a new permission'
  })

  await check('a private one is invisible to somebody else', async () => {
    const created = await saveReportDashboard(viewer, {
      name: `Private ${stamp}`,
      cards: ['site_sessions'],
      isShared: false,
    })
    const listed = await listReportDashboards(ctxFor('marketing'))
    expect(!listed.some((row) => row.id === created.id), 'a private dashboard is in somebody else’s list')
    // An admin can still open one, because an admin can open everything in the
    // workspace and pretending otherwise would be a lie about the role.
    expect(Boolean(await readReportDashboard(admin, created.id)), 'an admin could not open it')
    await deleteReportDashboard(viewer, created.id)
    return 'private is about clutter, not about secrecy'
  })

  await check('a shared one is in everybody’s list', async () => {
    const created = await saveReportDashboard(admin, {
      name: `Shared ${stamp}`,
      cards: ['deals_created', 'pipeline_funnel', 'first_touch'],
      isShared: true,
    })
    dashboardId = created.id
    const listed = await listReportDashboards(viewer)
    expect(listed.some((row) => row.id === dashboardId), 'a shared dashboard is missing from a viewer’s list')
    return `${listed.length} visible to a viewer`
  })

  await check('somebody else’s dashboard cannot be edited', async () => {
    try {
      await saveReportDashboard(viewer, {
        id: dashboardId,
        name: 'Hijacked',
        cards: ['site_sessions'],
        isShared: true,
      })
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
    throw new Error('a viewer rewrote an admin’s dashboard')
  })

  await check('the card order is what comes back', async () => {
    const order = ['first_touch', 'deals_created', 'pipeline_funnel']
    await saveReportDashboard(admin, {
      id: dashboardId,
      name: `Shared ${stamp}`,
      cards: order,
      isShared: true,
    })
    const read = await readReportDashboard(admin, dashboardId)
    expect(read?.cards.join(',') === order.join(','), read?.cards.join(',') ?? 'nothing came back')
    return 'order is the only layout a dashboard has, so it is stored'
  })

  await check('a card that no longer exists does not break it', async () => {
    await saveReportDashboard(admin, {
      id: dashboardId,
      name: `Shared ${stamp}`,
      cards: ['deals_created', 'a_card_that_was_retired'],
      isShared: true,
    })
    const read = await readReportDashboard(admin, dashboardId)
    // Stored as written. Dropping it happens where the dashboard is drawn, so a
    // card removed from the catalogue and put back does not lose its place.
    expect(read?.cards.length === 2, `${read?.cards.length} keys stored`)
    await deleteReportDashboard(admin, dashboardId)
    expect((await readReportDashboard(admin, dashboardId)) === null, 'it survived its deletion')
    return 'an unknown key is dropped when drawn, not when stored'
  })

  console.log('')
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`)
    process.exitCode = 1
  } else {
    console.log('all reporting checks passed.')
  }
} finally {
  await owner.end({ timeout: 5 })
  await closeAppPool()
}
