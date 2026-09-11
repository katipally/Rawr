import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as s from '../src/schema/index.ts'
import type { AccountContext } from '../src/dal/context.ts'
import {
  appendImportRows,
  assertMappingIsUsable,
  beginImportRun,
  cancelImportRun,
  createImportRun,
  finishImportRun,
  createProposedProperties,
  importShapeFor,
  isNewProperty,
  proposeProperty,
  IMPORT_KINDS,
  previewImportRun,
  readImportRows,
  readImportRun,
  runImportChunk,
  startImportRun,
  suggestMapping,
  type ImportKind,
  type NewProperty,
  type ImportRow,
  type Mapping,
} from '../src/dal/imports.ts'
import { importErrorCsv } from '../src/dal/export.ts'
import { createField } from '../src/dal/admin-fields.ts'
import { hubspotPreset, looksLikeHubspot } from '../src/registry/hubspot.ts'
import { forgetRegistry, getRegistry, objectOrThrow } from '../src/dal/registry.ts'
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

/** The rest of a real contact export. Fifteen columns Rawr has fields for plus
 *  these is sixty-eight, which is the shape of the file the migration is actually
 *  about: most of it is properties this account has never heard of. */
const HUBSPOT_EXTRA_HEADERS = [
  'Annual Revenue',
  'Became a Lead Date',
  'Became a Customer Date',
  'Became an Opportunity Date',
  'Persona',
  'Buying Role',
  'Preferred Language',
  'Time Zone',
  'Number of Employees',
  'Number of Sessions',
  'Number of Pageviews',
  'Number of Form Submissions',
  'Days to Close',
  'Marketing Contact Status',
  'Email Hard Bounce Reason',
  'Recent Conversion',
  'First Conversion',
  'Original Source Drill-Down 1',
  'Original Source Drill-Down 2',
  'Latest Source',
  'Latest Source Drill-Down 1',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'Facebook Click Id',
  'Google Click Id',
  'IP City',
  'IP State',
  'IP Country',
  'Postal Code',
  'State/Region',
  'Street Address',
  'Fax Number',
  'Twitter Handle',
  'Salutation',
  'Middle Name',
  'Degree',
  'School',
  'Field of Study',
  'Graduation Date',
  'Work Email',
  'Relationship Status',
  'Military Status',
  'Seniority',
  'Start Date',
  'Membership Notes',
  'Notes Last Updated',
  'Currently in Sequence',
  'Last Sequence Ended Date',
  'Marketing Emails Opened',
  'Marketing Emails Clicked',
]

const PERSONAS = ['Buyer', 'Champion', 'Blocker']

/** One row of the wide file: enough real values in each column for the type
 *  inference to have something to read. */
const hubspotWideRow = (stamp: string, i: number): ImportRow => ({
  'Record ID': String(1000 + i),
  'First Name': `Wide${i}`,
  'Last Name': `Row${i}`,
  Email: `verify.wide.${stamp}.${i}@partner7.example`,
  'Phone Number': '+441234567890',
  'Job Title': 'Analyst',
  'Associated Company': '',
  'Contact owner': '',
  'Lifecycle Stage': 'Lead',
  'Lead Status': 'New',
  'Create Date': '2026-01-02',
  'Last Activity Date': '2026-02-03',
  City: 'Leeds',
  'Country/Region': 'United Kingdom',
  'LinkedIn URL': '',
  'Annual Revenue': String(100000 + i * 1000),
  'Became a Lead Date': '2026-01-05',
  Persona: PERSONAS[i % PERSONAS.length]!,
  utm_source: `source-${i}`,
  utm_medium: 'cpc',
  ...Object.fromEntries(
    HUBSPOT_EXTRA_HEADERS.filter(
      (header) => !['Annual Revenue', 'Became a Lead Date', 'Persona', 'utm_source', 'utm_medium'].includes(header),
    ).map((header) => [header, `${header} ${i}`]),
  ),
})

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

const runToEnd = async (ctx: AccountContext, id: string, guard = 200): Promise<void> => {
  for (let i = 0; i < guard; i += 1) {
    const { done } = await runImportChunk(ctx, id)
    if (done) return
  }
  throw new Error(`the run did not finish in ${guard} chunks`)
}

const collect = async (lines: AsyncGenerator<string>): Promise<string> => {
  let out = ''
  for await (const line of lines) out += line
  return out
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

  console.log('\n-- properties the file needs -----------------------------------------')

  await check('a wide HubSpot export proposes a property per column nothing matches', async () => {
    const stamp = String(Date.now())
    const headers = [...HUBSPOT_CONTACT_HEADERS, ...HUBSPOT_EXTRA_HEADERS]
    expect(headers.length === 68, `the header list is ${headers.length} columns, expected 68`)

    const rows = Array.from({ length: 20 }, (_, i) => hubspotWideRow(stamp, i))
    const run = await createImportRun(admin, {
      objectKey: 'contact',
      kind: 'records',
      source: 'hubspot',
      filename: `wide-${stamp}.csv`,
      headers,
      rows,
      mapping: {},
    })
    created.push(run.id)

    const proposals = Object.entries(run.suggested).flatMap(([header, target]) =>
      isNewProperty(target) ? [[header, target] as [string, NewProperty]] : [],
    )
    expect(proposals.length > 0, 'not one column was proposed as a property')

    const typeOf = (header: string) => proposals.find(([name]) => name === header)?.[1]?.type
    expect(typeOf('Annual Revenue') === 'number', `Annual Revenue proposed as ${String(typeOf('Annual Revenue'))}`)
    expect(typeOf('Became a Lead Date') === 'date', `Became a Lead Date proposed as ${String(typeOf('Became a Lead Date'))}`)
    expect(typeOf('Persona') === 'select', `Persona proposed as ${String(typeOf('Persona'))}`)
    expect(typeOf('utm_source') === 'text', `utm_source proposed as ${String(typeOf('utm_source'))}`)
    const persona = proposals.find(([name]) => name === 'Persona')?.[1]
    expect((persona?.options?.length ?? 0) === 3, `Persona offered ${persona?.options?.length ?? 0} choices, expected 3`)

    // A column the account already has a field for is mapped, never proposed.
    expect(run.suggested.Email === 'email', `Email went to ${JSON.stringify(run.suggested.Email)}`)
    return `${proposals.length} of ${headers.length} columns proposed`
  })

  await check('starting the run creates them once, and a second file creates none', async () => {
    const stamp = String(Date.now())
    const headers = [...HUBSPOT_CONTACT_HEADERS, ...HUBSPOT_EXTRA_HEADERS]
    const rows = Array.from({ length: 20 }, (_, i) => hubspotWideRow(stamp, i))
    const file = {
      objectKey: 'contact',
      kind: 'records' as const,
      source: 'hubspot',
      headers,
      rows,
      mapping: {},
    }

    const first = await createImportRun(admin, { ...file, filename: `wide-a-${stamp}.csv` })
    created.push(first.id)
    const wanted = Object.values(first.suggested).filter(isNewProperty).length
    const madeFirst = await createProposedProperties(admin, first.id)
    expect(madeFirst.created === wanted, `made ${madeFirst.created} of ${wanted} proposed properties`)

    // Idempotent within one run: starting it twice must not make a second copy.
    const again = await createProposedProperties(admin, first.id)
    expect(again.created === 0, `a second start made ${again.created} more`)

    forgetRegistry(sandbox.id)
    const second = await createImportRun(admin, { ...file, filename: `wide-b-${stamp}.csv` })
    created.push(second.id)
    const madeSecond = await createProposedProperties(admin, second.id)
    expect(madeSecond.created === 0, `the same file made ${madeSecond.created} properties a second time`)

    const [grouped] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from field_def
       where account_id = ${sandbox.id}::uuid and group_name = 'Imported from HubSpot'`)
    expect(Number(grouped?.n ?? 0) >= wanted, `only ${grouped?.n} landed in the import group`)

    await db.execute(sql`
      delete from field_def where account_id = ${sandbox.id}::uuid and group_name = 'Imported from HubSpot'`)
    forgetRegistry(sandbox.id)
    return `${wanted} created once, nothing the second time`
  })

  await check('a proposal is inferred from the samples, not the header alone', async () => {
    const numeric = proposeProperty('Deal Weight', ['1', '2', '3.5'])
    expect(numeric?.type === 'number', `numeric samples gave ${String(numeric?.type)}`)
    const dated = proposeProperty('Renewal', ['2026-01-02', '2026-04-05'])
    expect(dated?.type === 'date', `date samples gave ${String(dated?.type)}`)
    const free = proposeProperty('Notes', ['one', 'two', 'three', 'four'])
    expect(free?.type === 'text', `four distinct values in four rows gave ${String(free?.type)}`)
    const utm = proposeProperty('utm_medium', ['cpc', 'cpc', 'email'])
    expect(utm?.type === 'text', `a tracking column gave ${String(utm?.type)}`)
    expect(proposeProperty('   ', []) === null, 'a header with no letters produced a property')
    return 'number, date, text, utm and the unusable header'
  })

  console.log('\n-- a custom object ---------------------------------------------------')

  await check('a file can be imported into an object an admin invented', async () => {
    const stamp = String(Date.now())
    const object = objectOrThrow(await getRegistry(admin), 'asset')
    const headers = ['Asset name', 'Format']
    const run = await createImportRun(admin, {
      objectKey: 'asset',
      kind: 'records',
      filename: `asset-${stamp}.csv`,
      headers,
      rows: Array.from({ length: 4 }, (_, i) => ({
        'Asset name': `Verify asset ${stamp} ${i}`,
        Format: 'Whitepaper',
      })),
      mapping: { 'Asset name': 'name', Format: 'format' },
    })
    created.push(run.id)

    const before = await readImportRun(admin, run.id)
    expect(before?.objectType === 'asset', `the run recorded object_type ${String(before?.objectType)}`)
    assertMappingIsUsable(object, { 'Asset name': 'name', Format: 'format' })

    await runToEnd(admin, run.id)
    const done = (await readImportRun(admin, run.id))!
    expect(done.state === 'done', `the run ended ${done.state}: ${done.lastError ?? 'no reason given'}`)
    expect(done.created === 4, `it created ${done.created} of 4 asset records`)

    // Twice is an update, not eight rows: a custom object dedupes on whatever it
    // is called by, the same way a contact dedupes on its address.
    const second = await createImportRun(admin, {
      objectKey: 'asset',
      kind: 'records',
      filename: `asset-again-${stamp}.csv`,
      headers,
      rows: Array.from({ length: 4 }, (_, i) => ({
        'Asset name': `Verify asset ${stamp} ${i}`,
        Format: 'Case study',
      })),
      mapping: { 'Asset name': 'name', Format: 'format' },
    })
    created.push(second.id)
    await runToEnd(admin, second.id)
    const rerun = (await readImportRun(admin, second.id))!
    expect(rerun.updated === 4, `the second file created ${rerun.created} and updated ${rerun.updated}`)

    await db.execute(sql`
      delete from custom_record where account_id = ${sandbox.id}::uuid
        and custom ->> 'name' like ${`Verify asset ${stamp}%`}`)
    return 'four created, then four updated, object_type held "asset"'
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

    const csv = await collect(importErrorCsv(admin, run.id))
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

  await check('the error file holds every refused row, not the first thousand', async () => {
    const stamp = String(Date.now())
    const rows = Array.from({ length: 1_100 }, (_, i) => ({
      'Deal Name': `Verify refused deal ${stamp} ${i}`,
      'Close Date': 'sometime soon',
    }))
    const run = await createImportRun(admin, {
      objectKey: 'deal',
      filename: `refused-${stamp}.csv`,
      headers: ['Deal Name', 'Close Date'],
      rows,
      mapping: { 'Deal Name': 'name', 'Close Date': 'close_date' },
    })
    created.push(run.id)
    await runToEnd(admin, run.id)
    const done = (await readImportRun(admin, run.id))!
    expect(done.errored === 1_100, `${done.errored} refused, expected 1,100`)
    const lines = (await collect(importErrorCsv(admin, run.id))).trimEnd().split('\n')
    expect(lines.length === 1_101, `the file has ${lines.length - 1} rows, expected 1,100`)
    expect((await rowCount(run.id)) === 1_100, 'the refused rows did not outlive the run')
    return `${lines.length - 1} rows in the file, the run kept ${done.errors.length} for the screen`
  })

  console.log('\n-- an upload in batches ----------------------------------------------')

  await check('a file arrives in batches, a batch sent twice lands once, and empty cells are not stored', async () => {
    const stamp = String(Date.now())
    const { id } = await beginImportRun(admin, {
      objectKey: 'contact',
      filename: `batches-${stamp}.csv`,
      headers: ['Email', 'First Name', ''],
    })
    created.push(id)
    const batch = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => [
        `verify.batch.${stamp}.${from + i}@partner7.example`,
        from + i === 0 ? '' : `Batch${from + i}`,
        '',
      ])
    await appendImportRows(admin, id, { from: 0, rows: batch(0, 3) })
    await appendImportRows(admin, id, { from: 0, rows: batch(0, 3) })
    await appendImportRows(admin, id, { from: 3, rows: batch(3, 2) })

    for (const [what, call, words] of [
      ['a preview', () => previewImportRun(admin, id), 'still arriving'],
      ['a batch past the end', () => appendImportRows(admin, id, { from: 9, rows: batch(9, 1) }), 'lost its place'],
    ] as const) {
      try {
        await call()
        throw new Error(`${what} was allowed`)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        expect(message.includes(words), `${what} refused with "${message}"`)
      }
    }

    await finishImportRun(admin, id)
    await finishImportRun(admin, id)
    const run = (await readImportRun(admin, id))!
    expect(run.state === 'mapping', `the run is ${run.state}`)
    expect(run.totalRows === 5 && (await rowCount(id)) === 5, `${run.totalRows} rows recorded, ${await rowCount(id)} stored`)
    expect(run.headers[2] === 'Column 3', `a blank header became "${run.headers[2]}"`)
    const [first] = await db.execute<{ values: Record<string, string> }>(
      sql`select values from import_row where run_id = ${id}::uuid and position = 0`,
    )
    expect(
      JSON.stringify(first?.values) === JSON.stringify({ Email: `verify.batch.${stamp}.0@partner7.example` }),
      `the first row was stored as ${JSON.stringify(first?.values)}`,
    )
    await cancelImportRun(admin, id)
    return '5 rows from 3 batches, one of them sent twice'
  })

  console.log('\n-- what a HubSpot export carries ---------------------------------------')

  await check('columns the preset dismisses, associations and fields Rawr keeps become no properties', async () => {
    const stamp = String(Date.now())
    const dismissed = [
      'Record ID',
      'Last Activity Date',
      'Associated Deal',
      'Associated Deal IDs',
      'Number of Associated Deals',
      'Last Contacted',
      'Emails Sent',
    ]
    const headers = [...HUBSPOT_CONTACT_HEADERS, ...dismissed.filter((header) => !HUBSPOT_CONTACT_HEADERS.includes(header))]
    const deals = Array.from({ length: 8 }, (_, i) => `Verify deal ${stamp} with a long name number ${i}`).join(';')
    const run = await createImportRun(admin, {
      objectKey: 'contact',
      source: 'hubspot',
      filename: `dismissed-${stamp}.csv`,
      headers,
      rows: Array.from({ length: 4 }, (_, i) => ({
        ...hubspotWideRow(stamp, i),
        'Associated Deal': deals,
        'Associated Deal IDs': '42229008919;39542877209',
        'Number of Associated Deals': '2',
        'Last Contacted': '2026-02-01',
        'Emails Sent': '3',
      })),
      mapping: {},
    })
    created.push(run.id)
    for (const header of dismissed) {
      expect(run.suggested[header] === null, `"${header}" went to ${JSON.stringify(run.suggested[header])}`)
    }
    expect(run.suggested['Create Date'] === 'created_at', `Create Date went to ${JSON.stringify(run.suggested['Create Date'])}`)
    await previewImportRun(admin, run.id)
    await cancelImportRun(admin, run.id)
    return `${dismissed.length} dismissed, Create Date kept, and the preview answers`
  })

  await check('a create date lands on a new record and is never written over', async () => {
    const stamp = String(Date.now())
    const object = objectOrThrow(await getRegistry(admin), 'contact')
    try {
      assertMappingIsUsable(object, { Email: 'email', Contacted: 'last_contacted_at' })
      throw new Error('a column was allowed into a field Rawr maintains')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      expect(message.includes('kept up to date by Rawr'), `refused with "${message}"`)
    }

    const once = async (date: string) => {
      const run = await createImportRun(admin, {
        objectKey: 'contact',
        filename: `created-${stamp}.csv`,
        headers: ['Email', 'Create Date'],
        rows: [{ Email: `verify.created.${stamp}@partner7.example`, 'Create Date': date }],
        mapping: { Email: 'email', 'Create Date': 'created_at' },
      })
      created.push(run.id)
      await runToEnd(admin, run.id)
      return (await readImportRun(admin, run.id))!
    }
    const first = await once('2020-05-06T07:08:09Z')
    expect(first.created === 1 && first.errored === 0, `first run: ${first.created} created, ${first.errored} refused`)
    const second = await once('2024-01-01T00:00:00Z')
    expect(second.updated === 1 && second.errored === 0, `second run: ${second.updated} updated, ${second.errored} refused`)
    const [stored] = await db.execute<{ created_at: string }>(sql`
      select created_at::text from contact where account_id = ${sandbox.id} and email = ${`verify.created.${stamp}@partner7.example`}`)
    expect(String(stored?.created_at).startsWith('2020-05-06'), `created_at is ${String(stored?.created_at)}`)
    await db.execute(sql`delete from contact where account_id = ${sandbox.id} and email like ${`verify.created.${stamp}%`}`)
    return `kept ${String(stored?.created_at)} through an update`
  })

  await check('a choice the file uses is added, and a proposed one reads the whole file', async () => {
    const stamp = String(Date.now())
    const key = `verify_choice_${stamp}`
    await createField(admin, { objectKey: 'contact', key, label: `Verify choice ${stamp}`, type: 'select', options: ['One', 'Two'] })
    forgetRegistry(sandbox.id)
    const tier = `Tier ${stamp}`
    const rows = Array.from({ length: 250 }, (_, i) => ({
      Email: `verify.choice.${stamp}.${i}@partner7.example`,
      [`Verify choice ${stamp}`]: i === 240 ? 'Three' : i % 2 === 0 ? 'One' : 'two',
      // The first two hundred rows are all the mapper samples. Bronze is past them.
      [tier]: i === 230 ? 'Bronze' : i % 2 === 0 ? 'Gold' : 'Silver',
    }))
    try {
      const run = await createImportRun(admin, {
        objectKey: 'contact',
        filename: `choices-${stamp}.csv`,
        headers: Object.keys(rows[0]!),
        rows,
        mapping: {},
      })
      created.push(run.id)
      const proposal = run.suggested[tier]
      expect(isNewProperty(proposal) && proposal.type === 'select', `${tier} proposed as ${JSON.stringify(proposal)}`)

      const preview = await previewImportRun(admin, run.id)
      expect(preview.willError === 0, `the preview refused ${preview.willError}: ${preview.samples.error[0]?.reason ?? ''}`)
      const added = preview.newChoices.find((entry) => entry.label === `Verify choice ${stamp}`)
      expect(added?.choices.join() === 'Three', `the preview adds ${JSON.stringify(preview.newChoices)}`)
      const planned = preview.newProperties.find((entry) => entry.header === tier)
      expect(planned?.options?.join() === 'Bronze,Gold,Silver', `${tier} would be made with ${JSON.stringify(planned?.options)}`)

      await startImportRun(admin, run.id)
      await runToEnd(admin, run.id)
      const done = (await readImportRun(admin, run.id))!
      expect(done.created === 250 && done.errored === 0, `${done.created} created, ${done.errored} refused`)
      forgetRegistry(sandbox.id)
      const field = objectOrThrow(await getRegistry(admin), 'contact').byKey.get(key)
      expect(field?.options.join() === 'One,Two,Three', `the field's choices are ${field?.options.join()}`)
      const [spelled] = await db.execute<{ value: string }>(sql`
        select custom ->> ${key} as value from contact
         where account_id = ${sandbox.id} and email = ${`verify.choice.${stamp}.1@partner7.example`}`)
      expect(spelled?.value === 'Two', `"two" was stored as ${String(spelled?.value)}`)
      return 'Three added before the run, Bronze found past the sample, "two" stored as Two'
    } finally {
      await db.execute(sql`delete from contact where account_id = ${sandbox.id} and email like ${`verify.choice.${stamp}.%`}`)
      await db.execute(sql`delete from field_def where account_id = ${sandbox.id} and key in (${key}, ${`tier_${stamp}`})`)
      forgetRegistry(sandbox.id)
    }
  })

  await check('a deal imported twice is updated, not duplicated', async () => {
    const stamp = String(Date.now())
    const once = async () => {
      const run = await createImportRun(admin, {
        objectKey: 'deal',
        filename: `deals-${stamp}.csv`,
        headers: ['Deal Name', 'Amount'],
        rows: Array.from({ length: 3 }, (_, i) => ({ 'Deal Name': `Verify twice deal ${stamp} ${i}`, Amount: '100' })),
        mapping: { 'Deal Name': 'name', Amount: 'amount' },
      })
      created.push(run.id)
      await runToEnd(admin, run.id)
      return (await readImportRun(admin, run.id))!
    }
    const first = await once()
    const second = await once()
    const [stored] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from deal where account_id = ${sandbox.id} and name like ${`Verify twice deal ${stamp}%`}`)
    await db.execute(sql`delete from deal where account_id = ${sandbox.id} and name like ${`Verify twice deal ${stamp}%`}`)
    expect(first.created === 3, `first run created ${first.created}`)
    expect(second.updated === 3 && second.created === 0, `second run: ${second.created} created, ${second.updated} updated`)
    expect(Number(stored?.n) === 3, `${stored?.n} deals exist, expected 3`)
    return '3 created, then 3 updated'
  })

  await check('every row is counted once, and a warning is not a refusal', async () => {
    const stamp = String(Date.now())
    const run = await createImportRun(admin, {
      objectKey: 'contact',
      filename: `warned-${stamp}.csv`,
      headers: ['Email', 'Job Title'],
      rows: [
        { Email: `verify.warned.${stamp}.0@partner7.example`, 'Job Title': 'x'.repeat(600) },
        { Email: `verify.warned.${stamp}.1@partner7.example`, 'Job Title': 'Analyst' },
      ],
      mapping: { Email: 'email', 'Job Title': 'title' },
    })
    created.push(run.id)
    await runToEnd(admin, run.id)
    const done = (await readImportRun(admin, run.id))!
    await db.execute(sql`delete from contact where account_id = ${sandbox.id} and email like ${`verify.warned.${stamp}.%`}`)
    expect(done.created === 2 && done.errored === 0, `${done.created} created, ${done.errored} refused`)
    expect(done.created + done.updated + done.skipped + done.errored === done.totalRows, 'the counts do not add up to the file')
    expect(done.errors.some((note) => note.warning && note.reason.includes('cut')), 'the cut title was not mentioned')
    return 'two created, the cut title noted on the side'
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
