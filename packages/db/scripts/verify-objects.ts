import { createCustomObject, deleteCustomObject, listCustomObjects } from '../src/dal/objects.ts'
import { createField } from '../src/dal/admin-fields.ts'
import { createRecord, getRecord, listRecords, updateRecord, deleteRecord } from '../src/dal/records.ts'
import { forgetRegistry, getRegistry } from '../src/dal/registry.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import type { WorkspaceContext } from '../src/dal/context.ts'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import * as s from '../src/schema/index.ts'

const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })
const db = drizzle(owner, { schema: s })
const [ws] = await db.select().from(s.workspace).where(eq(s.workspace.slug, 'datasaur')).limit(1)
const [me] = await db.select().from(s.userAccount).limit(1)

const ctx: WorkspaceContext = { workspaceId: ws!.id, actorId: me!.id, actorKind: 'user', role: 'admin' }
let failures = 0
const check = async (what: string, fn: () => Promise<string>) => {
  try { console.log(`PASS  ${what}  ${await fn()}`) }
  catch (cause) { failures++; console.log(`FAIL  ${what}  ${cause instanceof Error ? cause.message : cause}`) }
}
const expect = (ok: boolean, why: string) => { if (!ok) throw new Error(why) }

let objectId = ''
let key = ''
let recordId = ''

try {
  await check('an object can be invented', async () => {
    const made = await createCustomObject(ctx, { nameSingular: 'Project', namePlural: 'Projects' })
    objectId = made.id
    key = made.key
    expect(key === 'project', key)
    forgetRegistry(ctx.workspaceId)
    const registry = await getRegistry(ctx)
    const object = registry.byKey.get('project')
    expect(Boolean(object), 'it is not in the registry')
    expect(object!.isCustom, 'it does not know it is custom')
    expect(object!.table === 'custom_record', object!.table)
    expect(object!.labelFieldKey === 'name', String(object!.labelFieldKey))
    return `${key}, in the shared table, named by "${object!.labelFieldKey}"`
  })

  await check('a reserved name is refused', async () => {
    try {
      await createCustomObject(ctx, { nameSingular: 'Contact', namePlural: 'Contacts' })
      throw new Error('it was allowed')
    } catch (cause) {
      const said = cause instanceof Error ? cause.message : String(cause)
      expect(said.includes('already uses'), said)
      return said
    }
  })

  await check('fields can be added to it', async () => {
    await createField(ctx, { objectKey: key, key: 'status', label: 'Status', type: 'select', options: ['Planned', 'Running', 'Done'] })
    await createField(ctx, { objectKey: key, key: 'starts_on', label: 'Starts on', type: 'date' })
    forgetRegistry(ctx.workspaceId)
    const object = (await getRegistry(ctx)).byKey.get(key)!
    expect(object.fields.length === 3, `${object.fields.length} fields`)
    // Every one is jsonb: a column would be a column on every custom object.
    expect(object.fields.every((f) => f.storage === 'jsonb'), 'a field claimed a column')
    return `${object.fields.map((f) => f.key).join(', ')}, all jsonb`
  })

  await check('a record is created and named', async () => {
    const made = await createRecord(ctx, key, { name: 'Atlas rollout', status: 'Running', starts_on: '2026-10-01' })
    recordId = made.id
    expect(made.displayName === 'Atlas rollout', made.displayName)
    return `"${made.displayName}"`
  })

  await check('it reads back with its values', async () => {
    const got = await getRecord(ctx, key, recordId)
    expect(got !== null, 'it is not there')
    expect(got!.values.status === 'Running', String(got!.values.status))
    expect(String(got!.values.starts_on).startsWith('2026-10-01'), String(got!.values.starts_on))
    return `status=${got!.values.status}, starts_on=${String(got!.values.starts_on).slice(0, 10)}`
  })

  await check('it lists, and only its own object appears', async () => {
    const page = await listRecords(ctx, { object: key, limit: 50 })
    expect(page.rows.length === 1, `${page.rows.length} rows`)
    expect(page.rows[0]!.displayName === 'Atlas rollout', page.rows[0]!.displayName)
    return `${page.rows.length} row, ${page.total} total`
  })

  await check('a second object does not see the first one’s records', async () => {
    const other = await createCustomObject(ctx, { nameSingular: 'Vendor', namePlural: 'Vendors' })
    forgetRegistry(ctx.workspaceId)
    await createRecord(ctx, other.key, { name: 'Acme Supplies' })
    const projects = await listRecords(ctx, { object: key, limit: 50 })
    const vendors = await listRecords(ctx, { object: other.key, limit: 50 })
    expect(projects.rows.length === 1, `${projects.rows.length} projects`)
    expect(vendors.rows.length === 1, `${vendors.rows.length} vendors`)
    expect(projects.rows[0]!.displayName === 'Atlas rollout', 'the wrong record')
    expect(vendors.rows[0]!.displayName === 'Acme Supplies', 'the wrong record')
    await deleteCustomObject(ctx, other.id)
    return 'one shared table, two objects, no bleed'
  })

  await check('filtering and sorting work on a jsonb field', async () => {
    await createRecord(ctx, key, { name: 'Beacon pilot', status: 'Planned', starts_on: '2026-09-15' })
    const running = await listRecords(ctx, {
      object: key,
      limit: 50,
      filters: [{ conjunction: 'and', conditions: [{ field: 'status', operator: 'is', value: 'Running' }] }],
    })
    expect(running.rows.length === 1, `${running.rows.length} matched`)
    const sorted = await listRecords(ctx, { object: key, limit: 50, sorts: [{ key: 'starts_on', direction: 'asc' }] })
    expect(sorted.rows[0]!.displayName === 'Beacon pilot', sorted.rows.map((r) => r.displayName).join(', '))
    return 'filtered to 1, sorted by date'
  })

  await check('search finds it', async () => {
    const found = await listRecords(ctx, { object: key, limit: 50, search: 'Atlas' })
    expect(found.rows.length === 1, `${found.rows.length} found`)
    return `"${found.rows[0]!.displayName}" by search vector`
  })

  await check('it updates, and the search vector follows', async () => {
    await updateRecord(ctx, key, recordId, { name: 'Atlas rollout phase two', status: 'Done' })
    const got = await getRecord(ctx, key, recordId)
    expect(got!.displayName === 'Atlas rollout phase two', got!.displayName)
    expect(got!.values.status === 'Done', String(got!.values.status))
    const found = await listRecords(ctx, { object: key, limit: 50, search: 'phase' })
    expect(found.rows.length === 1, `${found.rows.length} found after rename`)
    return 'renamed, and findable by the new name'
  })

  await check('it deletes softly and leaves the list', async () => {
    await deleteRecord(ctx, key, recordId)
    const page = await listRecords(ctx, { object: key, limit: 50 })
    expect(!page.rows.some((row) => row.id === recordId), 'it is still listed')
    return `${page.rows.length} left`
  })

  await check('deleting the object takes its records', async () => {
    await deleteCustomObject(ctx, objectId)
    const [{ n = 0 } = { n: 0 }] = await db.execute<{ n: number }>(
      `select count(*)::int as n from custom_record where object_id = '${objectId}'` as never,
    )
    expect(Number(n) === 0, `${n} records survived`)
    forgetRegistry(ctx.workspaceId)
    expect(!(await getRegistry(ctx)).byKey.has(key), 'it is still in the registry')
    return 'gone, the way dropping a table would have taken them'
  })

  await check('a core object cannot be deleted', async () => {
    const registry = await getRegistry(ctx)
    const contact = registry.byKey.get('contact')!
    try {
      await deleteCustomObject(ctx, contact.id)
      throw new Error('it was allowed')
    } catch (cause) {
      const said = cause instanceof Error ? cause.message : String(cause)
      expect(said.includes('built on'), said)
      return said
    }
  })

  console.log('')
  console.log(failures > 0 ? `${failures} check(s) failed.` : 'all custom object checks passed.')
  if (failures > 0) process.exitCode = 1
} finally {
  // Leave nothing behind, whatever happened above.
  await db.execute(`delete from object_def where is_custom = true and workspace_id = '${ws!.id}'` as never)
  await closeAppPool()
  await owner.end()
}
