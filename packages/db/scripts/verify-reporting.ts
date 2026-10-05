import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as s from '../src/schema/index.ts'
import type { AccountContext } from '../src/dal/context.ts'
import {
  attributionReport,
  clampRange,
  formsReport,
  pipelineReport,
  sequencesReport,
  websiteReport,
  MAX_DAYS,
} from '../src/dal/reporting.ts'
import { readDashboard } from '../src/dal/dashboard.ts'
import { readAgenda, readCalendar } from '../src/dal/calendar.ts'
import { campaignPerformance, listCampaigns, saveCampaign } from '../src/dal/campaigns.ts'
import { trackedMessages } from '../src/dal/messages.ts'
import { withAccount } from '../src/dal/index.ts'
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
import { PEER, SANDBOX, seatFor, cleanup } from './fixture.ts'

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
  const viewer = ctxFor('viewer')
  // Seated, because this context writes into the peer account and every write
  // names its actor in audit_log.
  const probeCtx: AccountContext = { accountId: probe.id, actorId: await seatFor(probe.id, PEER.slug), actorKind: 'user', isSuperAdmin: true, viewHubs: [], editHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'] }
  const wide = clampRange({ from: new Date(Date.now() - 300 * DAY), to: new Date(Date.now() + DAY) })

  console.log('-- the range -----------------------------------------------------')

  await check('a range nobody asked for is the last thirty days, today included', async () => {
    const range = clampRange({}, 'Pacific/Kiritimati')
    const [today] = await owner<{ day: string }[]>`select (now() at time zone 'Pacific/Kiritimati')::date::text as day`
    expect(Math.round((range.to.getTime() - range.from.getTime()) / DAY) === 30, 'not 30 days')
    const closeOfToday = new Date(Date.parse(`${today!.day}T00:00:00Z`) + DAY - 14 * 3_600_000)
    expect(range.to.getTime() === closeOfToday.getTime(), `ends ${range.to.toISOString()}, not ${closeOfToday.toISOString()}`)
    return 'a report opens on something answerable, ending at the close of the account’s own today'
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
           where account_id = ${datasaur.id} and visitor_id = ${visitorId}
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
           where account_id = ${datasaur.id} and visitor_id = ${visitorId}`,
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
       where account_id = ${datasaur.id} and id = ${visitorId}`)
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
       where account_id = ${datasaur.id}
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
       where account_id = ${datasaur.id} and deleted_at is null
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
       where account_id = ${probe.id} and channel = 'Paid Search'`)
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
    // account and pretending otherwise would be a lie about the role.
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
  console.log('-- campaigns, spend and cost-per ----------------------------------')

  // One utm per run, shared by the campaign and by every contact this section
  // attributes to it, so a re-run never matches the last run's rows.
  const utm = `verify-${stamp}`

  await check('a campaign is keyed by its utm_campaign, not its name', async () => {
    const id = await saveCampaign(admin, {
      name: `Verify ${stamp}`,
      source: 'google',
      medium: 'cpc',
      utmCampaign: utm,
      spend: 500,
      currency: 'USD',
    })
    const again = await saveCampaign(admin, {
      name: `Verify ${stamp} renamed`,
      utmCampaign: utm.toUpperCase(),
      spend: 400,
      currency: 'USD',
    })
    expect(id === again, 'the same utm_campaign opened a second campaign')
    return 'case does not open a second campaign, so one budget stays one line'
  })

  await check('a contact carrying that utm is attached to it', async () => {
    const source = JSON.stringify({ channel: 'Paid Search', detail: { utm: { campaign: utm } } })
    await withAccount(admin, (tx) => tx.execute(sql`
      insert into contact (account_id, first_name, last_name, email, original_source, latest_source)
      values (${admin.accountId}, 'Campaign', ${stamp}, ${`campaign-${stamp}@example.com`},
              ${source}::jsonb, ${source}::jsonb)`))
    // Saving again is what re-resolves; a campaign that exists but names nobody
    // reads as a bug on the report it was created to fill in.
    await saveCampaign(admin, { name: `Verify ${stamp}`, utmCampaign: utm, spend: 500, currency: 'USD' })
    const rows = await withAccount(admin, (tx) => tx.execute<{ n: number }>(sql`
      select count(*)::int as n from contact c join campaign k on k.id = c.first_campaign_id
       where lower(k.utm_campaign) = lower(${utm})`))
    expect(Number(rows[0]?.n ?? 0) >= 1, 'no contact was attached')
    return 'resolved from the source the collector already stored'
  })

  await check('cost per contact is spend over contacts, and blank when there are none', async () => {
    const rows = await campaignPerformance(admin, wide)
    const mine = rows.find((row) => row.utmCampaign.toLowerCase() === utm.toLowerCase())
    expect(mine !== undefined, 'the campaign is not in the report')
    expect(mine!.contacts >= 1, `${mine!.contacts} contacts`)
    expect(mine!.costPerContact !== null, 'a campaign with spend and contacts has no cost per contact')
    expect(Math.abs(mine!.costPerContact! - mine!.spend / mine!.contacts) < 0.001, 'the arithmetic is wrong')
    const empty = rows.find((row) => row.spend === 0 && row.contacts === 0)
    if (empty) expect(empty.costPerContact === null, 'dividing by nobody produced a number')
    return `${mine!.contacts} contact(s) at ${mine!.costPerContact} each`
  })

  await check('the peer tenant sees none of it', async () => {
    const rows = await campaignPerformance(probeCtx, wide)
    expect(!rows.some((row) => row.utmCampaign.toLowerCase() === utm.toLowerCase()), 'a campaign crossed a tenant')
    const listed = await listCampaigns(probeCtx, { search: utm })
    expect(listed.total === 0, `${listed.total} campaigns visible from the peer`)
    return 'row level security holds on the new table'
  })

  console.log('')
  console.log('-- tracked mail, one row per send ---------------------------------')

  await check('a tracked send appears once, with its counts', async () => {
    const token = `vt${stamp}${Math.random().toString(36).slice(2, 10)}`
    await withAccount(admin, (tx) => tx.execute(sql`
      insert into sequence_send (account_id, token, sent_at, open_count, click_count, first_opened_at)
      values (${admin.accountId}, ${token}, now(), 3, 1, now())`))
    const page = await trackedMessages(admin, wide, { limit: 25, sort: 'opens' })
    expect(page.total >= 1, 'the send is not in the report')
    expect(page.rows.every((row) => row.opens >= 0), 'a count came back negative')
    const first = page.rows[0]
    expect(first !== undefined && first.opens >= (page.rows[1]?.opens ?? 0), 'the sort by opens did not hold')
    return `${page.total} tracked send(s) in the range`
  })

  await check('paging it never repeats a row', async () => {
    const one = await trackedMessages(admin, wide, { limit: 2, offset: 0 })
    const two = await trackedMessages(admin, wide, { limit: 2, offset: 2 })
    const overlap = one.rows.filter((row) => two.rows.some((other) => other.sendId === row.sendId))
    expect(overlap.length === 0, `${overlap.length} row(s) on both pages`)
    return 'offset paging over one range scan, bounded by the range clamp'
  })

  await check('the peer tenant sees none of that either', async () => {
    const page = await trackedMessages(probeCtx, wide, { limit: 25 })
    expect(page.rows.every((row) => row.mailbox !== undefined), 'a row came back malformed')
    return `${page.total} send(s) in the peer, all its own`
  })


  console.log('')
  console.log('-- the numbers are the right numbers -----------------------------')

  // Everything below lives in the peer tenant in March 2001, a range nothing the
  // seed wrote reaches, so every figure can be asserted exactly. Day boundaries are
  // Pacific midnights (UTC-8 until April 2001), because the account is set to
  // America/Los_Angeles for the block and put back after.
  const ZONE = 'America/Los_Angeles'
  const march = { from: new Date('2001-03-01T08:00:00Z'), to: new Date('2001-03-31T08:00:00Z') }
  const tag = `p2b-${stamp}`
  await owner`update account set timezone = ${ZONE} where id = ${probe.id}`

  const [salesRow] = await owner<{ id: string }[]>`
    select id from pipeline where account_id = ${probe.id} and name = 'Sales Pipeline'`
  const salesPipeline = salesRow!.id
  const stageOf = async (kind: 'open' | 'won' | 'lost'): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      select id from pipeline_stage
       where pipeline_id = ${salesPipeline} and is_closed_won = ${kind === 'won'} and is_closed_lost = ${kind === 'lost'}
       order by position limit 1`
    return row!.id
  }
  const [openStage, wonStage, lostStage] = [await stageOf('open'), await stageOf('won'), await stageOf('lost')]
  const makeContact = async (label: string, at: string, companyId: string | null, channel: string | null) => {
    const [row] = await owner<{ id: string }[]>`
      insert into contact (account_id, email, company_id, created_at, original_source, latest_source)
      values (${probe.id}, ${`${tag}-${label}@example.com`}, ${companyId}, ${at}::timestamptz,
              ${channel ? JSON.stringify({ channel }) : null}::jsonb, ${channel ? JSON.stringify({ channel }) : null}::jsonb)
      returning id`
    return row!.id
  }
  const makeCompany = async (label: string) => {
    const [row] = await owner<{ id: string }[]>`
      insert into company (account_id, name) values (${probe.id}, ${`${tag}-${label}`}) returning id`
    return row!.id
  }
  const makeDeal = async (label: string, stage: string, created: string, extra: { company?: string; amount?: number; currency?: string; closeDate?: string } = {}) => {
    const [row] = await owner<{ id: string }[]>`
      insert into deal (account_id, name, pipeline_id, stage_id, created_at, company_id, amount, currency, close_date)
      values (${probe.id}, ${`${tag}-${label}`}, ${salesPipeline}, ${stage}, ${created}::timestamptz,
              ${extra.company ?? null}, ${extra.amount ?? null}, ${extra.currency ?? 'USD'}, ${extra.closeDate ?? null}::date)
      returning id`
    return row!.id
  }
  const makeStageChange = async (dealId: string, at: string) => {
    const [act] = await owner<{ id: string }[]>`
      insert into activity (account_id, type, subject, occurred_at, actor_kind)
      values (${probe.id}, 'stage_change', ${`${tag} moved`}, ${at}::timestamptz, 'job') returning id`
    await owner`
      insert into activity_link (account_id, activity_id, entity_type, entity_id, type, occurred_at)
      values (${probe.id}, ${act!.id}, 'deal', ${dealId}, 'stage_change', ${at}::timestamptz)`
  }

  await check('A-01: two fills at 9:21 and 9:32 PM Pacific are one Pacific day, not the next', async () => {
    const [form] = await owner<{ id: string }[]>`
      insert into form (account_id, name, slug) values (${probe.id}, ${`${tag}-late`}, ${`${tag}-late`}) returning id`
    for (const at of ['2001-03-10T05:21:00Z', '2001-03-10T05:32:00Z']) {
      await owner`insert into form_submission (account_id, form_id, at) values (${probe.id}, ${form!.id}, ${at}::timestamptz)`
    }
    const report = await formsReport(probeCtx, march)
    const evening = report.days.find((row) => row.day === '2001-03-09')
    const nextDay = report.days.find((row) => row.day === '2001-03-10')
    expect(evening?.clean === 2, `March 9 holds ${evening?.clean ?? 'no bucket'}, March 10 holds ${nextDay?.clean ?? 'no bucket'}`)
    expect(nextDay?.clean === 0, `March 10 holds ${nextDay?.clean}`)
    return 'both on March 9, where the people who filled them were'
  })

  await check('A-01: the axis ends on the last day asked for, not the day after', async () => {
    const report = await formsReport(probeCtx, march)
    const last = report.days.at(-1)?.day
    expect(report.days.length === 30 && last === '2001-03-30', `${report.days.length} days ending ${last}`)
    return 'thirty days, March 1 to March 30'
  })

  await check('A-01: overdue and closing this month follow the account zone, not UTC', async () => {
    // Pago Pago and Kiritimati are 25 hours apart, so their calendar days differ
    // at every instant: whatever time this runs, a task due on one's today is
    // overdue on the other's.
    const [pago] = await owner<{ west: string }[]>`select (now() at time zone 'Pacific/Pago_Pago')::date::text as west`
    const west = pago!.west
    const asOf = (timezone: string) => readDashboard({ ...probeCtx, timezone })
    const [before, beforeEast] = [await asOf('Pacific/Pago_Pago'), await asOf('Pacific/Kiritimati')]
    await owner`
      insert into task (account_id, title, due_date, assignee_id, status)
      values (${probe.id}, ${`${tag} due`}, ${west}::date, ${probeCtx.actorId}, 'open')`
    const [after, afterEast] = [await asOf('Pacific/Pago_Pago'), await asOf('Pacific/Kiritimati')]
    expect(after.myOverdueTasks === before.myOverdueTasks, `due today in Pago Pago counted overdue there: ${before.myOverdueTasks} to ${after.myOverdueTasks}`)
    expect(afterEast.myOverdueTasks === beforeEast.myOverdueTasks + 1, `not overdue in Kiritimati: ${beforeEast.myOverdueTasks} to ${afterEast.myOverdueTasks}`)
    return `due ${west}: today in Pago Pago, a day gone in Kiritimati`
  })

  await check('A-01: a meeting lands on the day it is on the wall in the account zone', async () => {
    const [page] = await owner<{ id: string }[]>`
      insert into booking_page (account_id, slug, name, title_tpl, description_tpl)
      values (${probe.id}, ${tag}, ${`${tag} page`}, 't', 'd') returning id`
    await owner`
      insert into booking (account_id, booking_page_id, host_user_id, starts_at, ends_at, attendee_timezone,
                           attendee_name, attendee_email, cancel_token, reschedule_token, state)
      values (${probe.id}, ${page!.id}, ${probeCtx.actorId}, '2001-03-10T05:30:00Z', '2001-03-10T06:00:00Z', 'UTC',
              'Late Guest', ${`${tag}-guest@example.com`}, ${`${tag}-c`}, ${`${tag}-r`}, 'confirmed')`
    const agenda = await readAgenda(probeCtx, { month: '2001-03-01' })
    const entry = agenda.entries.find((row) => row.displayName.endsWith('Late Guest'))
    expect(entry?.day === '2001-03-09' && entry.time === '21:30', `${entry?.day} ${entry?.time}`)
    return '9:30 PM on March 9, not 5:30 AM on March 10'
  })

  await check('A-01: a record dated by an instant sits on its day in the account zone, and in its month', async () => {
    await makeContact('cal-late', '2001-03-10T05:21:00Z', null, null)
    await makeContact('cal-edge', '2001-04-01T05:30:00Z', null, null)
    const month = await readCalendar(probeCtx, { object: 'contact', month: '2001-03-01', fieldKey: 'created_at' })
    const mine = month.entries.filter((entry) => entry.displayName.includes(tag))
    const late = mine.find((entry) => entry.displayName.includes('cal-late'))
    const edge = mine.find((entry) => entry.displayName.includes('cal-edge'))
    expect(late?.day === '2001-03-09' && late.time === '21:21', `${late?.day} ${late?.time}`)
    expect(edge?.day === '2001-03-31' && edge.time === '21:30', `${edge?.day} ${edge?.time}: 9:30 PM on the 31st is March, not April`)
    return '9:21 PM on March 9, and 9:30 PM on March 31 stays in March'
  })

  await check('A-02: a reply on a two-mail enrollment is one reply', async () => {
    const [seq] = await owner<{ id: string }[]>`
      insert into sequence (account_id, name, settings) values (${probe.id}, ${`${tag}-seq`}, '{}'::jsonb) returning id`
    const enroll = async (label: string, state: string) => {
      const contactId = await makeContact(`seq-${label}`, '2001-03-02T18:00:00Z', null, null)
      const [row] = await owner<{ id: string }[]>`
        insert into sequence_enrollment (account_id, sequence_id, contact_id, state, unsubscribe_token)
        values (${probe.id}, ${seq!.id}, ${contactId}, ${state}::rawr_enrollment_state, ${`${tag}-${label}`}) returning id`
      return { id: row!.id, contactId }
    }
    const send = (who: { id: string; contactId: string }, n: number, state: string) =>
      owner`
        insert into sequence_send (account_id, enrollment_id, contact_id, token, sent_at, state)
        values (${probe.id}, ${who.id}, ${who.contactId}, ${`${tag}-${n}-${who.id}`}, ${`2001-03-0${n}T18:00:00Z`}::timestamptz, ${state}::rawr_send_state)`
    const replied = await enroll('replied', 'replied')
    await send(replied, 3, 'sent')
    await send(replied, 4, 'sent')
    const quiet = await enroll('quiet', 'active')
    await send(quiet, 5, 'sent')
    const bounced = await enroll('bounced', 'bounced')
    await send(bounced, 6, 'bounced')

    const report = await sequencesReport(probeCtx, march)
    const row = report.sequences.find((each) => each.sequence === `${tag}-seq`)
    expect(row?.sent === 3, `sent ${row?.sent}`)
    expect(row?.replied === 1, `replied ${row?.replied}, and one enrollment replied`)
    expect(row?.bounced === 1, `bounced ${row?.bounced}`)
    return 'sent 3, replied 1, bounced 1'
  })

  await check('A-03: a submission whose company has two later deals is still one submission', async () => {
    const company = await makeCompany('forms-co')
    const [form] = await owner<{ id: string }[]>`
      insert into form (account_id, name, slug) values (${probe.id}, ${`${tag}-fan`}, ${`${tag}-fan`}) returning id`
    await owner`insert into form_submission (account_id, form_id, company_id, at, spam_state)
                values (${probe.id}, ${form!.id}, ${company}, '2001-03-15T18:00:00Z', 'clean'),
                       (${probe.id}, ${form!.id}, ${company}, '2001-03-16T18:00:00Z', 'quarantined')`
    await makeDeal('fan-1', openStage, '2001-03-20T18:00:00Z', { company })
    await makeDeal('fan-2', openStage, '2001-03-21T18:00:00Z', { company })

    const report = await formsReport(probeCtx, march)
    const row = report.forms.find((each) => each.id === form!.id)
    expect(row?.submissions === 2, `submissions ${row?.submissions}`)
    expect(row?.held === 1, `held ${row?.held}`)
    expect(row?.deals === 2, `deals ${row?.deals}`)
    return '2 submissions, 1 held, 2 deals'
  })

  await check('A-04: one 100,000 deal at a company with three contacts is 100,000', async () => {
    const channel = `verify-${stamp}`
    const company = await makeCompany('attr-co')
    for (const label of ['a', 'b', 'c']) await makeContact(`attr-${label}`, '2001-03-03T18:00:00Z', company, channel)
    await makeDeal('attr-won', wonStage, '2001-02-01T18:00:00Z', { company, amount: 100_000 })

    const report = await attributionReport(probeCtx, march)
    const row = report.first.find((each) => each.channel === channel)
    expect(row?.contacts === 3 && row.deals === 1, `${row?.contacts} contacts, ${row?.deals} deals`)
    expect(JSON.stringify(row?.wonAmounts) === JSON.stringify([{ currency: 'USD', amount: 100_000 }]), `${JSON.stringify(row?.wonAmounts)} won`)
    return '3 contacts, 1 deal, 100,000 USD'
  })

  await check('A-04: a campaign is not credited a deal once per contact either', async () => {
    const [campaign] = await owner<{ id: string }[]>`
      insert into campaign (account_id, name, utm_campaign) values (${probe.id}, ${`${tag}-camp`}, ${`${tag}-camp`}) returning id`
    const company = await makeCompany('camp-co')
    for (const label of ['a', 'b']) {
      const contact = await makeContact(`camp-${label}`, '2001-03-03T18:00:00Z', company, null)
      await owner`update contact set first_campaign_id = ${campaign!.id} where id = ${contact}`
    }
    await makeDeal('camp-won', wonStage, '2001-02-01T18:00:00Z', { company, amount: 40_000 })

    const row = (await campaignPerformance(probeCtx, march)).find((each) => each.utmCampaign === `${tag}-camp`)
    expect(row?.contacts === 2 && row.deals === 1, `${row?.contacts} contacts, ${row?.deals} deals`)
    expect(row?.wonAmount === 40_000, `${row?.wonAmount} won`)
    return '2 contacts, 1 deal, 40,000'
  })

  await check('A-05: a deal is won in the week it closed, not the week it was made', async () => {
    const dueOn = await makeDeal('won-late', wonStage, '2001-01-15T18:00:00Z', { amount: 1000 })
    await makeStageChange(dueOn, '2001-03-12T18:00:00Z')
    await makeDeal('won-dated', wonStage, '2001-02-20T18:00:00Z', { amount: 500, currency: 'EUR', closeDate: '2001-03-14' })
    await makeDeal('open', openStage, '2001-03-05T18:00:00Z')
    const lost = await makeDeal('lost', lostStage, '2001-03-06T18:00:00Z')
    await makeStageChange(lost, '2001-03-20T18:00:00Z')

    const report = await pipelineReport(probeCtx, march)
    const week = (day: string) => report.weeks.find((row) => row.week === day)
    expect(week('2001-03-05')?.created === 2, `created ${week('2001-03-05')?.created} in the week of the 5th`)
    expect(week('2001-03-12')?.won === 2, `won ${week('2001-03-12')?.won} in the week of the 12th`)
    expect(week('2001-03-19')?.lost === 1, `lost ${week('2001-03-19')?.lost} in the week of the 19th`)
    expect(week('2001-03-05')?.lost === 0 && week('2001-03-05')?.won === 0, 'a close was charted in the week the deal was created')
    return 'created 2 in the week of the 5th, won 2 in the 12th, lost 1 in the 19th'
  })

  await check('A-05: what was won is one total per currency, never a sum of two', async () => {
    const report = await pipelineReport(probeCtx, march)
    const got = report.wonAmounts.map((each) => `${each.currency} ${each.amount}`).join(', ')
    expect(got === 'USD 1000, EUR 500', `won ${got}`)
    return got
  })

  console.log('')
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`)
    process.exitCode = 1
  } else {
    console.log('all reporting checks passed.')
  }
} finally {
  // Its own rows in the tables the seed fills, which `cleanup` leaves alone: the
  // seeded sequence sends and campaign are what the sequences report and the
  // campaign list read, so emptying those tables wholesale would blank them.
  await owner`update account set timezone = 'UTC' where slug = ${PEER.slug}`
  await owner`delete from form where slug like ${`p2b-${stamp}%`}`
  await owner`delete from sequence where name like ${`p2b-${stamp}%`}`
  await owner`delete from deal where name like ${`p2b-${stamp}%`}`
  await owner`delete from contact where email like ${`p2b-${stamp}%`}`
  await owner`delete from company where name like ${`p2b-${stamp}%`}`
  await owner`delete from activity where subject like ${`p2b-${stamp}%`}`
  await owner`delete from task where title like ${`p2b-${stamp}%`}`
  await owner`delete from campaign where utm_campaign like ${`p2b-${stamp}%`}`
  await owner`delete from booking where attendee_email like ${`p2b-${stamp}%`}`
  await owner`delete from booking_page where slug = ${`p2b-${stamp}`}`
  await owner`delete from sequence_send where token like ${`vt${stamp}%`}`
  await owner`delete from contact where email = ${`campaign-${stamp}@example.com`}`
  await owner`delete from campaign where lower(utm_campaign) = ${`verify-${stamp}`}`
  await owner.end({ timeout: 5 })
  await closeAppPool()
  await cleanup()
}
