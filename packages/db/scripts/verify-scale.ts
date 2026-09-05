import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as s from '../src/schema/index.ts'
import type { Role, WorkspaceContext } from '../src/dal/context.ts'
import { listRecords } from '../src/dal/records.ts'
import { readBoard } from '../src/dal/board.ts'
import { searchAll } from '../src/dal/search.ts'
import { evaluateSegment, saveSegment } from '../src/dal/segments.ts'
import { findDuplicates } from '../src/dal/duplicates.ts'
import { attributionReport, formsReport, pipelineReport } from '../src/dal/reporting.ts'
import { closeAppPool } from '../src/internal/pool.ts'

/** B9. Whether any of this holds at the size of the portal it has to replace.
 *
 *  Not part of `pnpm verify`, on purpose. It writes a hundred thousand rows into
 *  a real database and takes minutes; running it on every check would make the
 *  check something people skip. Run it before a migration and after a change to
 *  anything the list, the board or a report reads.
 *
 *  It builds into the probe workspace rather than Datasaur, so a developer's own
 *  data is untouched, and it removes what it built even when a check fails.
 *
 *  The numbers below are ceilings a person would notice, not benchmarks. The
 *  point is to catch an accidental sequential scan, not to score the database. */

const CONTACTS = Number(process.env.SCALE_CONTACTS ?? 100_000)
const COMPANIES = Number(process.env.SCALE_COMPANIES ?? 40_000)
const BATCH = 5_000

/** A page a person is waiting on. Anything past this reads as broken. */
const INTERACTIVE_MS = 2_000
/** A report they asked for and expect to think about. */
const REPORT_MS = 6_000
/** A whole-table job nobody is watching, but which runs hourly. */
const JOB_MS = 60_000
/** A migration-shaped one-off: the first evaluation of a segment that takes in
 *  every contact at once writes a timeline entry for each of them. It happens
 *  when a list arrives from HubSpot and never again; the hourly run afterwards is
 *  a delta and is held to JOB_MS separately. */
const BULK_MS = 240_000
/** Two hundred sequential round trips to a hosted database. No budget here is
 *  meaningful, and the check inside is the real one: page 200 costs what page 2
 *  did. This exists only so a genuine hang still fails. */
const WALK_MS = 600_000

/** Eight, where every other suite is capped at two. The others run beside each
 *  other and beside a dev server and would exhaust the pooler; this one runs
 *  alone. At two, the board's three parallel reads queued for a connection and
 *  the suite reported three seconds for a screen that takes under a second on a
 *  real server, which is the measurement being wrong rather than the board. */
const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })
const db = drizzle(owner, { schema: s })

let failures = 0
const pass = (what: string, detail = '') => console.log(`PASS  ${what}${detail ? `  ${detail}` : ''}`)
const fail = (what: string, detail: string) => {
  failures += 1
  console.log(`FAIL  ${what}\n      ${detail}`)
}

/** Every check here is "does this finish", so the timing is the check and the
 *  helper does it rather than each one repeating a stopwatch. */
const timed = async (what: string, budgetMs: number, fn: () => Promise<string>): Promise<void> => {
  const started = performance.now()
  try {
    const detail = await fn()
    const took = Math.round(performance.now() - started)
    if (took > budgetMs) fail(what, `took ${took}ms, budget ${budgetMs}ms. ${detail}`)
    else pass(what, `${took}ms · ${detail}`)
  } catch (cause) {
    fail(what, reason(cause))
  }
}

/** Drizzle wraps a driver error in one whose message is the whole SQL text, and
 *  the sentence that says what went wrong is on `cause`. Without unwrapping it a
 *  failure here prints a query and no reason. */
const reason = (cause: unknown): string => {
  if (!(cause instanceof Error)) return String(cause)
  const inner = cause.cause
  if (inner instanceof Error) return `${inner.name}: ${inner.message}`
  return `${cause.name}: ${cause.message}`
}

const stamp = Math.random().toString(36).slice(2, 8)
let built = false
/** Set once every check has been attempted. Without it a throw during the build
 *  skipped straight to the summary, which then said everything held because
 *  nothing had failed yet. A run that did not finish is not a pass. */
let finished = false

try {
  const [probe] = await db.select().from(s.workspace).where(eq(s.workspace.slug, 'probe'))
  if (!probe) throw new Error('Run pnpm db:seed first.')
  const [member] = await db
    .select({ id: s.userAccount.id })
    .from(s.membership)
    .innerJoin(s.userAccount, eq(s.userAccount.id, s.membership.userId))
    .where(eq(s.membership.workspaceId, probe.id))
    .limit(1)
  if (!member) throw new Error('The probe workspace has no members.')

  const ctx: WorkspaceContext = {
    workspaceId: probe.id,
    actorId: member.id,
    actorKind: 'user',
    role: 'admin' as Role,
  }

  console.log(`-- building ${CONTACTS.toLocaleString()} contacts and ${COMPANIES.toLocaleString()} companies`)
  const buildStarted = performance.now()
  built = true

  // generate_series rather than a loop of inserts: a hundred thousand round trips
  // through a pooler is the slowest part of this script by an order of magnitude,
  // and it measures the network rather than the database.
  // The bounds are cast because `generate_series` is overloaded and a bare
  // parameter is ambiguous to the planner: "function generate_series(unknown,
  // unknown) is not unique".
  for (let from = 1; from <= COMPANIES; from += BATCH) {
    const to = Math.min(from + BATCH - 1, COMPANIES)
    await db.execute(sql`
      insert into company (workspace_id, name, domain, created_at)
      select ${probe.id}::uuid, 'Scale Co ' || n, 'scale-' || ${stamp} || '-' || n || '.test',
             now() - (n % 700) * interval '1 day'
        from generate_series(${from}::int, ${to}::int) as n`)
  }

  // Companies joined by position rather than looked up by name per row: a
  // correlated subquery here is a hundred thousand index probes, which measures
  // the seeding rather than the thing being seeded.
  for (let from = 1; from <= CONTACTS; from += BATCH) {
    const to = Math.min(from + BATCH - 1, CONTACTS)
    await db.execute(sql`
      with pool as (
        select id, (row_number() over (order by id) - 1) as k
          from company
         where workspace_id = ${probe.id}::uuid and domain like ${`scale-${stamp}-%`}
      )
      insert into contact (workspace_id, first_name, last_name, email, company_id, created_at)
      select ${probe.id}::uuid, 'Scale', 'Person ' || n,
             'scale-' || ${stamp} || '-' || n || '@example.test',
             p.id,
             now() - (n % 700) * interval '1 day'
        from generate_series(${from}::int, ${to}::int) as n
        join pool p on p.k = n % ${COMPANIES}::int`)
  }
  console.log(`   built in ${Math.round((performance.now() - buildStarted) / 1000)}s`)
  console.log('')

  // Warm the app pool and the field registry before anything is timed. Both are
  // paid once per process and neither is paid by a running server, so leaving
  // them inside the first check measures the script starting up.
  await listRecords(ctx, { object: 'contact', limit: 1 })

  await timed('the first page of a hundred thousand contacts', INTERACTIVE_MS, async () => {
    const page = await listRecords(ctx, { object: 'contact', limit: 50 })
    if (page.rows.length !== 50) throw new Error(`${page.rows.length} rows`)
    return '50 rows, no count asked for'
  })

  // Its own check because it is its own statement, run beside the page rather than
  // ahead of it. A count over the whole table is the slowest thing a list does and
  // the one a caller can turn off, so a regression here has to be legible as a
  // regression in counting and not in reading.
  await timed('and the count beside it', INTERACTIVE_MS, async () => {
    const page = await listRecords(ctx, { object: 'contact', limit: 50, count: true })
    if ((page.total ?? 0) < CONTACTS) throw new Error(`counted ${page.total}`)
    return `${page.total?.toLocaleString()} counted`
  })

  // Deliberately not a budget on the whole walk. Two hundred pages is two hundred
  // sequential round trips to a hosted database, so the total measures the network
  // and would fail on a train. What has to hold is that the two hundredth page
  // costs what the second one did: an offset pager walks 10,000 rows to skip them,
  // and that is the accidental quadratic a keyset cursor exists to avoid.
  await timed('page two hundred costs what page two did', WALK_MS, async () => {
    let cursor = null as Awaited<ReturnType<typeof listRecords>>['nextCursor']
    const each: number[] = []
    for (let page = 0; page < 200; page += 1) {
      const started = performance.now()
      const result = await listRecords(ctx, {
        object: 'contact',
        limit: 50,
        ...(cursor ? { cursor } : {}),
      })
      each.push(performance.now() - started)
      cursor = result.nextCursor
      if (!cursor) throw new Error(`ran out of rows at page ${page + 1}`)
    }

    const mean = (part: number[]) => part.reduce((sum, ms) => sum + ms, 0) / part.length
    const first = mean(each.slice(0, 10))
    const last = mean(each.slice(-10))
    // Round trips vary; a page that has started walking rows does not vary, it
    // grows. Half again as slow is well clear of the noise and well under what an
    // offset pager would show at page 200.
    if (last > first * 1.5) {
      throw new Error(`first ten pages ${Math.round(first)}ms each, last ten ${Math.round(last)}ms`)
    }
    return `${Math.round(first)}ms per page at the start, ${Math.round(last)}ms at page 200`
  })

  await timed('a filtered list over a hundred thousand rows', INTERACTIVE_MS, async () => {
    const page = await listRecords(ctx, {
      object: 'contact',
      limit: 50,
      count: true,
      filters: [{ conjunction: 'and', conditions: [{ field: 'email', operator: 'contains', value: stamp }] }],
    })
    return `${page.total?.toLocaleString()} matched`
  })

  await timed('full text search across them', INTERACTIVE_MS, async () => {
    const found = await searchAll(ctx, 'Scale Person 99999')
    return `${found.total} hit(s)`
  })

  await timed('the board', INTERACTIVE_MS, async () => {
    const board = await readBoard(ctx, {})
    return `${board.columns.length} columns`
  })

  await timed('the duplicate scan', REPORT_MS, async () => {
    const pairs = await findDuplicates(ctx, 'contact')
    return `${pairs.length} pair(s)`
  })

  await timed('three reports over a year', REPORT_MS, async () => {
    const range = { from: new Date(Date.now() - 365 * 86_400_000), to: new Date() }
    const [pipeline, forms, attribution] = await Promise.all([
      pipelineReport(ctx, range),
      formsReport(ctx, range),
      attributionReport(ctx, range),
    ])
    return `${pipeline.funnel.length} stages, ${forms.forms.length} forms, ${attribution.first.length} channels`
  })

  let segmentId = ''
  await timed('a segment taking in a hundred thousand contacts at once', BULK_MS, async () => {
    const created = await saveSegment(ctx, {
      objectKey: 'contact',
      name: `Scale ${stamp}`,
      filters: [{ conjunction: 'and', conditions: [{ field: 'email', operator: 'contains', value: stamp }] }],
    })
    segmentId = created.id
    const result = await evaluateSegment(ctx, segmentId)
    if (result.members < CONTACTS) throw new Error(`${result.members} members of ${CONTACTS}`)
    return `${result.entered.toLocaleString()} entered, and a timeline entry written for each`
  })

  finished = true
  // The shape the hourly job actually has. The first pass above is a migration
  // and happens once; every pass after it is a delta, and this is the one that
  // has to stay quick as the table grows.
  await timed('and re-evaluated on the hour, with nothing changed', JOB_MS, async () => {
    const result = await evaluateSegment(ctx, segmentId)
    if (result.entered !== 0 || result.exited !== 0) {
      throw new Error(`${result.entered} entered and ${result.exited} left when nothing changed`)
    }
    return `${result.members.toLocaleString()} members, no churn, nothing written`
  })
} finally {
  if (built) {
    console.log('')
    console.log('-- clearing up')
    const [probe] = await db.select().from(s.workspace).where(eq(s.workspace.slug, 'probe'))
    if (probe) {
      // Segment first: its membership rows reference the contacts.
      await db.execute(sql`delete from segment where workspace_id = ${probe.id} and name = ${`Scale ${stamp}`}`)
      await db.execute(sql`delete from contact where workspace_id = ${probe.id} and email like ${`scale-${stamp}-%`}`)
      await db.execute(sql`delete from company where workspace_id = ${probe.id} and domain like ${`scale-${stamp}-%`}`)

      // Every run deletes a few hundred thousand rows and leaves them as dead
      // tuples. Two runs in an afternoon and the next one is measuring the bloat
      // its predecessors left rather than the query it thinks it is timing.
      await db.execute(sql`vacuum (analyze) contact, company, segment_membership, activity, activity_link`)
    }
  }

  console.log('')
  if (!finished) {
    console.log('the run did not get as far as its checks.')
    process.exitCode = 1
  } else if (failures > 0) {
    console.log(`${failures} check(s) failed.`)
    process.exitCode = 1
  } else {
    console.log('everything holds at this size.')
  }
  await owner.end()
  await closeAppPool()
}
