import { readFile } from 'node:fs/promises'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as s from '../src/schema/index.ts'
import type { AccountContext } from '../src/dal/context.ts'
import {
  assertMappingIsUsable,
  cancelImportRun,
  createImportRun,
  importShapeFor,
  IMPORT_KINDS,
  previewImportRun,
  readImportRows,
  readImportRun,
  runImportChunk,
  startImportRun,
  suggestMapping,
  type ImportKind,
  type ImportRow,
  type Mapping,
} from '../src/dal/imports.ts'
import { errorCsv } from '../src/dal/export.ts'
import { hubspotPreset, looksLikeHubspot } from '../src/registry/hubspot.ts'
import { getRegistry, objectOrThrow } from '../src/dal/registry.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import { cleanup, PEER, SANDBOX } from './fixture.ts'

/** A8 at migration scale: 88,000 rows, a run that outlives the tab, and a preview
 *  that answers. Run against the real database rather than asserted in a review. */

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

/** The columns a HubSpot contact export actually carries, in the order the portal
 *  writes them. Copied from an export of portal 23334870 rather than invented, so
 *  a change to the preset is measured against the file people really upload. */
const HUBSPOT_CONTACT_HEADERS = [
  'Record ID',
  'First Name',
  'Last Name',
  'Email',
  'Phone Number',
  'Job Title',
  'Associated Company',
  'Contact owner',
  'Lifecycle Stage',
  'Lead Status',
  'Create Date',
  'Last Activity Date',
  'City',
  'Country/Region',
  'LinkedIn URL',
]

/** A plausible file per kind, so every one of the six is put through the mapper and
 *  the run rather than only the one people demo. */
const FILE_FOR: Record<ImportKind, { headers: string[]; row: (stamp: string, i: number) => ImportRow }> = {
  records: {
    headers: ['First Name', 'Last Name', 'Email', 'Job Title'],
    row: (stamp, i) => ({
      'First Name': `Imported${i}`,
      'Last Name': `Row${i}`,
      Email: `verify.imports.${stamp}.${i}@partner7.example`,
      'Job Title': 'Analyst',
    }),
  },
  activities: {
    headers: ['Contact email', 'Activity type', 'Subject', 'Activity date'],
    row: (stamp, i) => ({
      'Contact email': `verify.imports.${stamp}.${i}@partner7.example`,
      'Activity type': 'note',
      Subject: `Imported note ${stamp} ${i}`,
      'Activity date': '2026-01-05T10:00:00Z',
    }),
  },
  properties: {
    headers: ['Applies to', 'Property name', 'Type', 'Group'],
    row: (stamp, i) => ({
      'Applies to': 'contact',
      'Property name': `Verify imports ${stamp} ${i}`,
      Type: 'text',
      Group: 'Imported from HubSpot',
    }),
  },
  associations: {
    headers: ['Deal', 'Contact email', 'Role'],
    row: (stamp, i) => ({
      Deal: `No such deal ${stamp} ${i}`,
      'Contact email': `verify.imports.${stamp}.${i}@partner7.example`,
      Role: 'Decision maker',
    }),
  },
  lists: {
    headers: ['List', 'Contact email'],
    row: (stamp, i) => ({
      List: `Verify imports ${stamp}`,
      'Contact email': `verify.imports.${stamp}.${i}@partner7.example`,
    }),
  },
  submissions: {
    headers: ['Form', 'Contact email', 'Submitted at'],
    row: (stamp, i) => ({
      Form: `Verify imports ${stamp}`,
      'Contact email': `verify.imports.${stamp}.${i}@partner7.example`,
      'Submitted at': '2026-01-05T10:00:00Z',
    }),
  },
}

/** Next compiles a matcher `source` with path-to-regexp. Only two forms appear in
 *  ours, so only two are translated: a parenthesised group is raw regex and is
 *  copied through, `:name*` is zero or more segments. Anything else would need the
 *  real library, and a check that quietly mistranslated its input would be worse
 *  than no check at all, so it refuses instead. */
const compileMatcher = (source: string): RegExp => {
  let out = ''
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!
    if (char === '(') {
      let depth = 1
      let j = i + 1
      while (j < source.length && depth > 0) {
        if (source[j] === '(') depth += 1
        if (source[j] === ')') depth -= 1
        j += 1
      }
      out += source.slice(i, j)
      i = j - 1
      continue
    }
    if (char === ':') {
      const name = /^:([A-Za-z0-9_]+)(\*?)/.exec(source.slice(i))
      if (!name) throw new Error(`unsupported matcher token in ${source}`)
      if (name[2] !== '*') throw new Error(`unsupported matcher modifier in ${source}`)
      out += '(.*)'
      i += name[0].length - 1
      continue
    }
    if ('.+?^${}|[]\\'.includes(char)) throw new Error(`unsupported matcher character "${char}" in ${source}`)
    out += char
  }
  return new RegExp(`^${out}$`)
}

const runToEnd = async (ctx: AccountContext, id: string, guard = 200): Promise<void> => {
  for (let i = 0; i < guard; i += 1) {
    const { done } = await runImportChunk(ctx, id)
    if (done) return
  }
  throw new Error(`the run did not finish in ${guard} chunks`)
}

const rowCount = async (runId: string): Promise<number> => {
  const [row] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from import_row where run_id = ${runId}::uuid`,
  )
  return Number(row?.n ?? 0)
}

/** Every run this suite creates, dropped at the end. import_run and import_row are
 *  tables the seed fills, so `cleanup` leaves them alone by design and a suite
 *  that made rows there clears its own. */
const created: string[] = []

const startRun = async (
  ctx: AccountContext,
  kind: ImportKind,
  stamp: string,
  count: number,
  objectKey = 'contact',
): Promise<string> => {
  const file = FILE_FOR[kind]!
  const rows = Array.from({ length: count }, (_, i) => file.row(stamp, i))
  const run = await createImportRun(ctx, {
    objectKey,
    kind,
    filename: `${kind}-${stamp}.csv`,
    headers: file.headers,
    rows,
    mapping: {},
  })
  created.push(run.id)
  return run.id
}

try {
  const [sandbox] = await db.select().from(s.account).where(eq(s.account.slug, SANDBOX.slug))
  const [peer] = await db.select().from(s.account).where(eq(s.account.slug, PEER.slug))
  if (!sandbox || !peer) throw new Error('Run pnpm db:seed first.')

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
    .where(eq(s.membership.accountId, sandbox.id))

  const ctxFor = (seat: string): AccountContext => {
    const member = members.find((m) => m.email === `${seat}@${SANDBOX.domain}`)
    if (!member) throw new Error(`no seeded ${seat}`)
    return {
      accountId: sandbox.id,
      actorId: member.id,
      actorKind: 'user',
      isSuperAdmin: member.isSuperAdmin,
      viewHubs: member.viewHubs,
      editHubs: member.editHubs,
    }
  }
  const admin = ctxFor('admin')
  const viewer = ctxFor('viewer')

  const [peerSeat] = await db
    .select({ id: s.membership.userId })
    .from(s.membership)
    .where(eq(s.membership.accountId, peer.id))
    .limit(1)
  const peerCtx: AccountContext = {
    accountId: peer.id,
    actorId: peerSeat?.id ?? null,
    actorKind: 'user',
    isSuperAdmin: true,
    viewHubs: [],
    editHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'],
  }

  console.log('\n-- the mapper --------------------------------------------------------')

  await check('a real HubSpot contact export maps its own columns', async () => {
    const object = objectOrThrow(await getRegistry(admin), 'contact')
    // Through the preset, which is the path a real upload takes: the run detects
    // the export from the headers themselves, without being told where it came from.
    expect(looksLikeHubspot(HUBSPOT_CONTACT_HEADERS), 'the file was not recognised as a HubSpot export')
    const mapping = suggestMapping(object, HUBSPOT_CONTACT_HEADERS, hubspotPreset('contact', HUBSPOT_CONTACT_HEADERS))
    const wanted: Record<string, string> = {
      'First Name': 'first_name',
      'Last Name': 'last_name',
      Email: 'email',
      'Job Title': 'title',
      'Associated Company': 'company_id',
      'Contact owner': 'owner_id',
      'LinkedIn URL': 'linkedin_url',
    }
    for (const [header, key] of Object.entries(wanted)) {
      expect(mapping[header] === key, `"${header}" mapped to ${String(mapping[header])}, wanted ${key}`)
    }
    assertMappingIsUsable(object, mapping)
    const unmapped = HUBSPOT_CONTACT_HEADERS.filter((h) => !mapping[h])
    return `${HUBSPOT_CONTACT_HEADERS.length - unmapped.length} of ${HUBSPOT_CONTACT_HEADERS.length} columns matched`
  })

  await check('every import kind has a shape a file can be mapped against', async () => {
    const registry = await getRegistry(admin)
    for (const kind of IMPORT_KINDS) {
      const object = importShapeFor(kind) ?? objectOrThrow(registry, 'contact')
      const mapping = suggestMapping(object, FILE_FOR[kind]!.headers)
      assertMappingIsUsable(object, mapping, kind)
    }
    return IMPORT_KINDS.join(', ')
  })

  await check('a file of every kind runs to done with every row accounted for', async () => {
    const summary: string[] = []
    for (const kind of IMPORT_KINDS) {
      const stamp = String(Date.now())
      const id = await startRun(admin, kind, stamp, 6)
      await runToEnd(admin, id)
      const run = (await readImportRun(admin, id))!
      expect(run.state === 'done', `${kind} ended ${run.state}: ${run.lastError ?? 'no reason given'}`)
      const accounted = run.created + run.updated + run.skipped + run.errored
      expect(accounted === run.totalRows, `${kind} accounted for ${accounted} of ${run.totalRows} rows`)
      summary.push(`${kind} ${run.created}/${run.updated}/${run.skipped}/${run.errored}`)

      // The four shapes that write something outside the run: properties make
      // fields, submissions make the form they belong to, lists make the segment.
      await db.execute(
        sql`delete from field_def where account_id = ${sandbox.id} and label like ${`Verify imports ${stamp}%`}`,
      )
      await db.execute(sql`delete from form where account_id = ${sandbox.id} and name = ${`Verify imports ${stamp}`}`)
      await db.execute(sql`delete from segment where account_id = ${sandbox.id} and name = ${`Verify imports ${stamp}`}`)
      await db.execute(
        sql`delete from contact where account_id = ${sandbox.id} and email like ${`verify.imports.${stamp}.%`}`,
      )
    }
    return summary.join('; ')
  })

  console.log('\n-- rows at scale -----------------------------------------------------')

  await check('the file is stored row by row, readable by position', async () => {
    const stamp = String(Date.now())
    const id = await startRun(admin, 'records', stamp, 2_500)
    expect((await rowCount(id)) === 2_500, `import_row holds ${await rowCount(id)} rows, expected 2,500`)
    const window = await readImportRows(admin, id, 1_000, 5)
    expect(window.length === 5, `asked for 5 rows from position 1,000 and got ${window.length}`)
    expect(
      window[0]!.Email === `verify.imports.${stamp}.1000@partner7.example`,
      `position 1,000 held ${String(window[0]!.Email)}`,
    )
    return '2,500 rows written in batches, read back by position range'
  })

  await check('a run that finishes keeps its counts and drops its rows', async () => {
    const stamp = String(Date.now())
    const id = await startRun(admin, 'records', stamp, 20)
    await runToEnd(admin, id)
    const run = (await readImportRun(admin, id))!
    expect(run.state === 'done', `the run ended ${run.state}`)
    expect(run.created === 20, `created ${run.created}`)
    expect((await rowCount(id)) === 0, `${await rowCount(id)} rows survived a finished run`)
    await db.execute(
      sql`delete from contact where account_id = ${sandbox.id} and email like ${`verify.imports.${stamp}.%`}`,
    )
    return '20 created, import_row emptied'
  })

  await check('the same file imported twice creates then updates, with no duplicates', async () => {
    const stamp = String(Date.now())
    const once = async () => {
      const id = await startRun(admin, 'records', stamp, 20)
      await runToEnd(admin, id)
      return (await readImportRun(admin, id))!
    }
    const first = await once()
    expect(first.created === 20 && first.updated === 0, `first run: ${first.created} created, ${first.updated} updated`)
    const second = await once()
    expect(second.updated === 20 && second.created === 0, `second run: ${second.created} created, ${second.updated} updated`)

    const [stored] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from contact
       where account_id = ${sandbox.id} and email like ${`verify.imports.${stamp}.%`} and deleted_at is null`)
    expect(Number(stored?.n) === 20, `${stored?.n} contacts exist, expected 20`)
    await db.execute(
      sql`delete from contact where account_id = ${sandbox.id} and email like ${`verify.imports.${stamp}.%`}`,
    )
    return '20 created, then 20 updated, 20 rows total'
  })

  await check('owner names nobody matches are collected once, and the rows still land', async () => {
    const stamp = String(Date.now())
    const rows = Array.from({ length: 30 }, (_, i) => ({
      Email: `verify.owners.${stamp}.${i}@partner7.example`,
      'Contact owner': i % 2 === 0 ? 'Departed Person' : 'Another Ghost',
    }))
    const run = await createImportRun(admin, {
      objectKey: 'contact',
      filename: `owners-${stamp}.csv`,
      headers: ['Email', 'Contact owner'],
      rows,
      mapping: {},
    })
    created.push(run.id)
    await runToEnd(admin, run.id)
    const done = (await readImportRun(admin, run.id))!
    expect(done.created === 30, `${done.created} of 30 rows landed`)
    expect(
      done.unmatchedOwners.length === 2,
      `${done.unmatchedOwners.length} owner names reported, expected 2: ${done.unmatchedOwners.join(', ')}`,
    )
    const [unassigned] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from contact
       where account_id = ${sandbox.id} and email like ${`verify.owners.${stamp}.%`} and owner_id is null`)
    expect(Number(unassigned?.n) === 30, `${unassigned?.n} of 30 came in unassigned`)
    await db.execute(
      sql`delete from contact where account_id = ${sandbox.id} and email like ${`verify.owners.${stamp}.%`}`,
    )
    return `two names for thirty rows: ${done.unmatchedOwners.join(', ')}`
  })

  console.log('\n-- preview -----------------------------------------------------------')

  await check('the preview reads the stored rows and says what it covered', async () => {
    const stamp = String(Date.now())
    const id = await startRun(admin, 'records', stamp, 700)
    const preview = await previewImportRun(admin, id)
    expect(preview.total === 700, `the preview claimed ${preview.total} rows`)
    expect(preview.checked === 500, `${preview.checked} rows were checked, expected the 500 window`)
    expect(
      preview.willCreate + preview.willUpdate + preview.willSkip + preview.willError === 700,
      'the four counts do not add up to the file',
    )
    expect(preview.samples.create.length > 0, 'a preview with no worked example is a number nobody can check')
    return `${preview.checked} of ${preview.total} checked, ${preview.willCreate} to create`
  })

  await check('a run is never left stuck in previewing', async () => {
    const stamp = String(Date.now())
    const id = await startRun(admin, 'records', stamp, 10)
    await previewImportRun(admin, id)
    expect((await readImportRun(admin, id))!.state === 'mapping', 'the run stayed in previewing')
    // Re-entering is the recovery: a preview interrupted half way is asked again.
    await previewImportRun(admin, id)
    expect((await readImportRun(admin, id))!.state === 'mapping', 'the second preview left it stuck')
    return 'previewing is transient, and re-enterable'
  })

  await check('a started run cannot be previewed, and says so in a sentence', async () => {
    const stamp = String(Date.now())
    const id = await startRun(admin, 'records', stamp, 5)
    await startImportRun(admin, id)
    try {
      await previewImportRun(admin, id)
      throw new Error('the preview was allowed')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      expect(message.includes('already been started'), `refused with "${message}"`)
      await cancelImportRun(admin, id)
      return message
    }
  })

  console.log('\n-- running without a tab ---------------------------------------------')

  await check('start marks the run running and leaves the work to the worker', async () => {
    const stamp = String(Date.now())
    const id = await startRun(admin, 'records', stamp, 400)
    await startImportRun(admin, id)
    const started = (await readImportRun(admin, id))!
    expect(started.state === 'running', `the run is ${started.state}`)
    expect(started.processedRows === 0, `${started.processedRows} rows were imported by the click itself`)
    await cancelImportRun(admin, id)
    await db.execute(
      sql`delete from contact where account_id = ${sandbox.id} and email like ${`verify.imports.${stamp}.%`}`,
    )
    return 'running, nothing processed yet'
  })

  await check('a run picked up after the process died continues from where it stopped', async () => {
    const stamp = String(Date.now())
    const id = await startRun(admin, 'records', stamp, 500)
    await startImportRun(admin, id)
    const first = await runImportChunk(admin, id)
    expect(!first.done && first.processed > 0, `one chunk did ${first.processed} rows and said done=${first.done}`)

    // Nothing carried over in memory: the next caller is a different process, and
    // all it has is the id.
    await runToEnd(admin, id)
    const done = (await readImportRun(admin, id))!
    expect(done.state === 'done', `the resumed run ended ${done.state}`)
    expect(done.processedRows === 500, `${done.processedRows} of 500 rows processed`)
    expect(done.created === 500, `${done.created} created, expected 500 with no repeats`)

    const [stored] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from contact
       where account_id = ${sandbox.id} and email like ${`verify.imports.${stamp}.%`} and deleted_at is null`)
    expect(Number(stored?.n) === 500, `${stored?.n} contacts exist, expected 500`)
    await db.execute(
      sql`delete from contact where account_id = ${sandbox.id} and email like ${`verify.imports.${stamp}.%`}`,
    )
    return `resumed at row ${first.processed}, finished at 500 with no duplicates`
  })

  await check('cancelling mid-run stops it for good and a chunk in flight cannot undo it', async () => {
    const stamp = String(Date.now())
    const id = await startRun(admin, 'records', stamp, 400)
    await startImportRun(admin, id)
    await runImportChunk(admin, id)
    await cancelImportRun(admin, id)

    const stopped = (await readImportRun(admin, id))!
    expect(stopped.state === 'cancelled', `the run is ${stopped.state}`)
    expect((await rowCount(id)) === 0, `${await rowCount(id)} rows survived a cancelled run`)

    const after = await runImportChunk(admin, id)
    expect(after.done, 'the next chunk kept going')
    expect((await readImportRun(admin, id))!.state === 'cancelled', 'a late chunk wrote over the cancellation')
    await db.execute(
      sql`delete from contact where account_id = ${sandbox.id} and email like ${`verify.imports.${stamp}.%`}`,
    )
    return `stopped at ${stopped.processedRows} of ${stopped.totalRows}, rows dropped`
  })

  console.log('\n-- refusals ----------------------------------------------------------')

  await check('a refused row lands in the error CSV with every column it came with', async () => {
    const stamp = String(Date.now())
    const rows = [
      { 'Deal Name': `Verify import deal ${stamp} a`, 'Close Date': '2026-09-01', Note: 'fine' },
      { 'Deal Name': `Verify import deal ${stamp} b`, 'Close Date': 'next tuesday-ish', Note: 'bad date' },
    ]
    const run = await createImportRun(admin, {
      objectKey: 'deal',
      filename: `deals-${stamp}.csv`,
      headers: ['Deal Name', 'Close Date', 'Note'],
      rows,
      mapping: { 'Deal Name': 'name', 'Close Date': 'close_date', Note: null } as Mapping,
    })
    created.push(run.id)
    await runToEnd(admin, run.id)
    const done = (await readImportRun(admin, run.id))!
    expect(done.errored === 1, `${done.errored} rows were refused, expected 1`)

    const csv = errorCsv(done.errors)
    const header = csv.split('\n')[0]!
    for (const column of ['Row', 'Reason', 'Deal Name', 'Close Date', 'Note']) {
      expect(header.includes(column), `the CSV header has no "${column}": ${header}`)
    }
    expect(csv.includes('next tuesday-ish'), 'the refused row lost the value that caused it')
    await db.execute(
      sql`delete from deal where account_id = ${sandbox.id} and name like ${`Verify import deal ${stamp}%`}`,
    )
    return header
  })

  await check('a seat with no contacts access cannot start or preview an import', async () => {
    const stamp = String(Date.now())
    const id = await startRun(admin, 'records', stamp, 5)
    for (const [what, call] of [
      ['start', () => startImportRun(viewer, id)],
      ['preview', () => previewImportRun(viewer, id)],
      ['a chunk', () => runImportChunk(viewer, id)],
    ] as const) {
      try {
        await call()
        throw new Error(`${what} was allowed`)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        expect(message.includes('access'), `${what} refused with "${message}"`)
      }
    }
    return 'start, preview and chunk all refused'
  })

  console.log('\n-- tenancy -----------------------------------------------------------')

  await check("another tenant cannot read or run this account's import", async () => {
    const stamp = String(Date.now())
    const id = await startRun(admin, 'records', stamp, 10)
    expect((await readImportRun(peerCtx, id)) === null, 'the peer read the run')
    expect((await readImportRows(peerCtx, id, 0, 10)).length === 0, 'the peer read the rows')
    try {
      await runImportChunk(peerCtx, id)
      throw new Error('the peer ran a chunk of it')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      expect(message.includes('no longer exists'), `refused with "${message}"`)
    }
    expect((await rowCount(id)) === 10, 'the peer took the rows with it')
    return 'invisible to the peer tenant, rows included'
  })

  console.log('\n-- the upload path ---------------------------------------------------')

  await check('the proxy matcher does not cover the upload route', async () => {
    const source = await readFile(new URL('../../../apps/web/src/proxy.ts', import.meta.url), 'utf8')
    const literal = /export const config = \{[\s\S]*?matcher: \[([\s\S]*?)\]/.exec(source)
    expect(!!literal, 'proxy.ts has no matcher array this check can read')
    const matchers = [...literal![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    expect(matchers.length > 0, 'the matcher array is empty')

    const upload = '/contacts/sandbox/import/upload'
    for (const matcher of matchers) {
      expect(
        !compileMatcher(matcher).test(upload),
        `"${matcher}" matches ${upload}, so Next buffers the body against the 10MB cap and truncates a real export`,
      )
    }
    // The account switch still has to happen everywhere else under /contacts.
    const record = '/contacts/sandbox/record/contact/x'
    expect(
      matchers.some((matcher) => compileMatcher(matcher).test(record)),
      `no matcher covers ${record}, so opening another account's link would show the wrong tenant`,
    )
    return `${matchers.length} matchers: upload excluded, ${record} still covered`
  })

  console.log('')
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`)
    process.exitCode = 1
  } else {
    console.log('all import checks passed.')
  }
} finally {
  for (const id of created) {
    await db.execute(sql`delete from import_run where id = ${id}::uuid`).catch(() => undefined)
  }
  await cleanup().catch((cause: unknown) => {
    console.log(`      fixtures could not be emptied: ${cause instanceof Error ? cause.message : String(cause)}`)
  })
  await owner.end()
  await closeAppPool()
}
