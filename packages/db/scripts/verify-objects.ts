import { createCustomObject, deleteCustomObject } from '../src/dal/objects.ts'
import { readTimeline, timelineCounts } from '../src/dal/activity.ts'
import { associate, groupFor, readAssociations } from '../src/dal/associations.ts'
import { createTask, listTasks, logByHand } from '../src/dal/tasks.ts'
import { listAttachments, recordAttachment } from '../src/dal/attachments.ts'
import { hitsOf, searchAll } from '../src/dal/search.ts'
import { resolveRecord } from '../src/dal/resolve.ts'
import { createField, deleteField, fieldUsage, purgeField } from '../src/dal/admin-fields.ts'
import { dropIndexSql, planFieldIndex, promoteFieldToHot } from '../src/dal/fields.ts'
import { readCalendar } from '../src/dal/calendar.ts'
import { listViews } from '../src/dal/views.ts'
import { createRecord, getRecord, listDeletedRecords, listRecords, restoreRecords, updateRecord, deleteRecord } from '../src/dal/records.ts'
import { forgetRegistry, getRegistry } from '../src/dal/registry.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import type { AccountContext } from '../src/dal/context.ts'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { and, eq, isNull } from 'drizzle-orm'
import * as s from '../src/schema/index.ts'
import { SANDBOX, cleanup } from './fixture.ts'

const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })
const db = drizzle(owner, { schema: s })
const [ws] = await db.select().from(s.account).where(eq(s.account.slug, SANDBOX.slug)).limit(1)
const [me] = await db.select().from(s.userAccount).limit(1)

const ctx: AccountContext = { accountId: ws!.id, actorId: me!.id, actorKind: 'user', isSuperAdmin: true, viewHubs: [], editHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'] }
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
    forgetRegistry(ctx.accountId)
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
    forgetRegistry(ctx.accountId)
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

  await check('its calendar reads custom_record and shows only its own records', async () => {
    const month = await readCalendar(ctx, { object: key, month: '2026-10-15', fieldKey: 'starts_on' })
    expect(month.entries.length === 1, `${month.entries.length} entries`)
    expect(month.entries[0]!.id === recordId && month.entries[0]!.day === '2026-10-01', JSON.stringify(month.entries[0]))
    const later = await readCalendar(ctx, { object: key, month: '2026-11-01', fieldKey: 'starts_on' })
    expect(later.entries.length === 0, `${later.entries.length} entries in the wrong month`)
    return `"${month.entries[0]!.displayName}" on ${month.entries[0]!.day}`
  })

  await check('its default view lists its first fields as columns', async () => {
    const [view] = await listViews(ctx, key)
    const fields = (await getRegistry(ctx)).byKey.get(key)!.fields.map((f) => f.key)
    expect(view!.columns.length === 3 && view!.columns.join() === fields.join(), view!.columns.join())
    return view!.columns.join(', ')
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
    forgetRegistry(ctx.accountId)
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


  // ---- what widening rawr_entity_type unlocked -----------------------------

  await check('creating it wrote a timeline entry', async () => {
    const counts = await timelineCounts(ctx, { entityType: key, entityId: recordId })
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
    expect(total > 0, 'the timeline is empty, so nothing linked to a custom record')
    return `${total} entries, including the field_change from the create`
  })

  await check('a note lands on it and reads back', async () => {
    await logByHand(ctx, { type: 'note', body: 'Kicked off with the client.', entity: { entityType: key, entityId: recordId } })
    const page = await readTimeline(ctx, { entity: { entityType: key, entityId: recordId }, types: ['note'], limit: 10 })
    expect(page.rows.length === 1, `${page.rows.length} notes`)
    return page.rows[0]!.body ?? ''
  })

  await check('a task hangs on it and knows what it is called', async () => {
    await createTask(ctx, { title: 'Confirm the scope', entity: { entityType: key, entityId: recordId } })
    const [row] = await listTasks(ctx, { entity: { entityType: key, entityId: recordId } })
    expect(Boolean(row), 'the task did not come back')
    expect(row!.entityName === 'Atlas rollout phase two', `named "${row!.entityName}"`)
    return `"${row!.title}" on "${row!.entityName}"`
  })

  await check('it associates with a contact, and the rail names both sides', async () => {
    // Soft-deleted contacts are still rows, and readAssociations does not return
    // them: picking one here would look exactly like a link that was never made.
    const [someone] = await db
      .select({ id: s.contact.id })
      .from(s.contact)
      .where(and(eq(s.contact.accountId, ws!.id), isNull(s.contact.deletedAt)))
      .limit(1)
    await associate(ctx, { entityType: key, entityId: recordId }, { entityType: 'contact', entityId: someone!.id })

    const fromProject = groupFor(await readAssociations(ctx, { entityType: key, entityId: recordId }), 'contact')
    expect(Boolean(fromProject?.records.some((row) => row.id === someone!.id)), 'the contact is not on the project')

    const fromContact = groupFor(await readAssociations(ctx, { entityType: 'contact', entityId: someone!.id }), key)
    expect(Boolean(fromContact?.records.some((row) => row.id === recordId)), 'the project is not on the contact')
    expect(fromContact!.namePlural === 'Projects', fromContact!.namePlural)
    return 'linked, and the card is named by the registry both ways'
  })

  await check('a file hangs on it', async () => {
    await recordAttachment(ctx, {
      entityType: key,
      entityId: recordId,
      storageKey: `${ws!.id}/${key}/${recordId}/verify/plan.pdf`,
      filename: 'plan.pdf',
      bytes: 1024,
      mime: 'application/pdf',
    })
    const files = await listAttachments(ctx, { entityType: key, entityId: recordId })
    expect(files.length === 1, `${files.length} files`)
    return files[0]!.filename
  })

  await check('global search returns it under its own object', async () => {
    const hits = hitsOf(await searchAll(ctx, 'Atlas'), key)
    expect(hits.length === 1, `${hits.length} hits`)
    expect(hits[0]!.id === recordId, 'a different record came back')
    return `"${hits[0]!.displayName}" under ${key}`
  })

  await check('an agent can resolve it by name', async () => {
    const found = await resolveRecord(ctx, key, 'Atlas rollout phase two')
    expect(found.kind === 'one', `resolution was ${found.kind}`)
    return found.kind === 'one' ? found.record.displayName : ''
  })

  await check('it deletes softly and leaves the list', async () => {
    await deleteRecord(ctx, key, recordId)
    const page = await listRecords(ctx, { object: key, limit: 50 })
    expect(!page.rows.some((row) => row.id === recordId), 'it is still listed')
    return `${page.rows.length} left`
  })

  await check('a deleted record is listed by name and restore puts it back', async () => {
    const gone = await listDeletedRecords(ctx, key, { search: 'phase two' })
    expect(gone.rows.length === 1 && gone.rows[0]!.id === recordId, `${gone.rows.length} deleted records matched`)
    expect(gone.rows[0]!.name === 'Atlas rollout phase two', gone.rows[0]!.name)
    const result = await restoreRecords(ctx, key, [recordId])
    expect(result.restored === 1 && result.failed.length === 0, JSON.stringify(result.failed))
    const back = await listRecords(ctx, { object: key, limit: 50 })
    expect(back.rows.some((row) => row.id === recordId), 'it did not come back to the list')
    expect((await listDeletedRecords(ctx, key)).total === 0, 'it is still listed as deleted')
    await deleteRecord(ctx, key, recordId)
    return 'listed under its old name, restored, and deleted again'
  })

  await check('a contact cannot come back over another that took its email', async () => {
    const email = `restore.${Date.now()}@restore.example`
    const first = await createRecord(ctx, 'contact', { first_name: 'Restore', last_name: 'First', email })
    await deleteRecord(ctx, 'contact', first.id)
    const second = await createRecord(ctx, 'contact', { first_name: 'Restore', last_name: 'Second', email })
    const result = await restoreRecords(ctx, 'contact', [first.id])
    expect(result.restored === 0 && result.failed.length === 1, `${result.restored} restored`)
    expect(result.failed[0]!.reason.includes('now belongs to another record'), result.failed[0]!.reason)
    await deleteRecord(ctx, 'contact', second.id)
    return result.failed[0]!.reason
  })

  await check('a property of a custom object can be indexed, on an index named by its id', async () => {
    await createField(ctx, { objectKey: key, key: 'budget', label: 'Budget', type: 'number' })
    forgetRegistry(ctx.accountId)
    const fieldId = (await getRegistry(ctx)).byKey.get(key)!.byKey.get('budget')!.id
    const promoted = await promoteFieldToHot(ctx, fieldId)
    expect(promoted.pgIndexName === `hot_cr_${fieldId.replaceAll('-', '')}`, promoted.pgIndexName)
    const [row] = await owner`select state, attempts, pg_index_name from field_index where id = ${promoted.fieldIndexId}`
    expect(row?.state === 'pending' && row.attempts === 0, JSON.stringify(row))
    try {
      await promoteFieldToHot(ctx, fieldId)
      throw new Error('a second promotion was allowed')
    } catch (cause) {
      expect(cause instanceof Error && cause.message.includes('already a hot field'), String(cause))
    }
    return promoted.pgIndexName
  })

  await check('a type no index can serve is refused before anything is written', async () => {
    await createField(ctx, { objectKey: key, key: 'tags', label: 'Tags', type: 'multi_select', options: ['A', 'B'] })
    forgetRegistry(ctx.accountId)
    const fieldId = (await getRegistry(ctx)).byKey.get(key)!.byKey.get('tags')!.id
    try {
      await promoteFieldToHot(ctx, fieldId)
      throw new Error('it was allowed')
    } catch (cause) {
      const said = cause instanceof Error ? cause.message : String(cause)
      expect(said.includes('cannot be indexed on a custom object'), said)
      const [{ n = 0 } = { n: 0 }] = await owner`select count(*)::int as n from field_index where field_id = ${fieldId}`
      expect(n === 0, `${n} index rows were written`)
      return said
    }
  })

  await check('the date parsers are immutable, never raise, and read a bad value as empty', async () => {
    const [fns] = await owner`
      select count(*)::int as n, bool_and(provolatile = 'i') as immutable
        from pg_proc where pronamespace = 'public'::regnamespace and proname in ('stored_date', 'stored_timestamptz')`
    expect(fns?.n === 2 && fns.immutable === true, JSON.stringify(fns))
    const [row] = await owner`
      select public.stored_date('2026-10-01') = date '2026-10-01' as day,
             public.stored_date('2026-02-30') is null as impossible_day,
             public.stored_date('not a date') is null as words,
             public.stored_timestamptz('2026-10-01T09:30:15.250Z') = timestamptz '2026-10-01 09:30:15.250+00' as moment,
             public.stored_timestamptz('2026-10-01T09:30:00+05:30') = timestamptz '2026-10-01 04:00:00+00' as shifted,
             public.stored_timestamptz('2026-10-01T25:00:00Z') is null as impossible_hour`
    expect(Object.values(row!).every((value) => value === true), JSON.stringify(row))
    return 'immutable, and a value that is not a day or a moment is null'
  })

  await check('a bad stored date empties that one row and breaks nothing', async () => {
    const [bad] = await owner`
      insert into custom_record (account_id, object_id, custom)
      values (${ctx.accountId}, ${objectId}, '{"name":"Hand edited","starts_on":"2026-02-30"}'::jsonb)
      returning id`
    const sorted = await listRecords(ctx, { object: key, limit: 50, sorts: [{ key: 'starts_on', direction: 'asc' }] })
    expect(sorted.rows.at(-1)?.id === bad!.id, 'the bad row is not last')
    const month = await readCalendar(ctx, { object: key, month: '2026-10-15', fieldKey: 'starts_on' })
    expect(!month.entries.some((entry) => entry.id === bad!.id), 'the bad row was placed on a day')
    const dated = await listRecords(ctx, {
      object: key,
      limit: 50,
      filters: [{ conjunction: 'and', conditions: [{ field: 'starts_on', operator: 'on_or_after', value: '2000-01-01' }] }],
    })
    expect(!dated.rows.some((row) => row.id === bad!.id), 'the bad row matched a date filter')
    await owner`delete from custom_record where id = ${bad!.id}`
    return 'sorted last, off the calendar, outside every date filter'
  })

  await check('a date property can be indexed, and its index is accepted by Postgres', async () => {
    const fieldId = (await getRegistry(ctx)).byKey.get(key)!.byKey.get('starts_on')!.id
    const { name, create } = planFieldIndex({
      fieldId,
      fieldKey: 'starts_on',
      fieldType: 'date',
      objectKey: key,
      objectId,
      isCustomObject: true,
    })
    await owner.unsafe(create)
    try {
      const [built] = await owner`select i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = ${name}`
      expect(built?.indisvalid === true, JSON.stringify(built))
    } finally {
      await owner.unsafe(dropIndexSql(name))
    }
    const promoted = await promoteFieldToHot(ctx, fieldId)
    expect(promoted.pgIndexName === name, promoted.pgIndexName)
    return name
  })

  await check('a failed build is asked again through the same call, and a good one is not', async () => {
    const fieldId = (await getRegistry(ctx)).byKey.get(key)!.byKey.get('budget')!.id
    await owner`update field_index set state = 'failed', last_error = 'boom', attempts = 3 where field_id = ${fieldId}`
    const again = await promoteFieldToHot(ctx, fieldId)
    const [row] = await owner`select state, attempts, last_error, claimed_at from field_index where id = ${again.fieldIndexId}`
    expect(row?.state === 'pending' && row.attempts === 0 && row.last_error === null && row.claimed_at === null, JSON.stringify(row))
    return 'back to pending with its count cleared'
  })

  await check('the index is unique within an account, not across them', async () => {
    const [index] = await owner`select indexdef from pg_indexes where indexname = 'field_index_account_name_key'`
    expect(Boolean(index?.indexdef.includes('(account_id, pg_index_name)')), String(index?.indexdef))
    const [old] = await owner`select 1 from pg_indexes where indexname = 'field_index_name_key'`
    expect(!old, 'the account-wide unique index is still there')
    return index!.indexdef
  })

  await check('deleting an indexed property takes its index row, and the object takes the rest', async () => {
    const fieldId = (await getRegistry(ctx)).byKey.get(key)!.byKey.get('budget')!.id
    await deleteField(ctx, fieldId)
    const [{ n = 0 } = { n: 0 }] = await owner`select count(*)::int as n from field_index where field_id = ${fieldId}`
    expect(n === 0, `${n} index rows survived`)
    return 'the worker sweep drops the index itself on its next pass'
  })

  await check('counting and purging a custom object’s property touches only that object’s rows', async () => {
    const other = await createCustomObject(ctx, { nameSingular: 'Vendor', namePlural: 'Vendors' })
    for (const objectKey of [key, other.key]) await createField(ctx, { objectKey, key: 'codename', label: 'Codename', type: 'text' })
    forgetRegistry(ctx.accountId)
    await createRecord(ctx, key, { name: 'Probe', codename: 'alpha' })
    await createRecord(ctx, other.key, { name: 'Acme', codename: 'beta' })
    const registry = await getRegistry(ctx)
    const fieldId = registry.byKey.get(key)!.byKey.get('codename')!.id
    const usage = await fieldUsage(ctx, fieldId)
    expect(usage.filled === 1, `${usage.filled} counted, one record holds it`)
    await deleteField(ctx, fieldId)
    const purged = await purgeField(ctx, fieldId)
    expect(purged.stripped === 1, `${purged.stripped} stripped`)
    const [{ n = 0 } = { n: 0 }] = await owner`
      select count(*)::int as n from custom_record where object_id = ${other.id} and custom ? 'codename'`
    expect(n === 1, `${n} of the other object's values survived`)
    await deleteCustomObject(ctx, other.id)
    return 'one counted, one stripped, the other object untouched'
  })

  await check('deleting the object takes its records', async () => {
    await deleteCustomObject(ctx, objectId)
    const [{ n = 0 } = { n: 0 }] = await db.execute<{ n: number }>(
      `select count(*)::int as n from custom_record where object_id = '${objectId}'` as never,
    )
    expect(Number(n) === 0, `${n} records survived`)

    // None of these is a foreign key, so the cascade cannot reach them. A link
    // left behind is a card on a contact naming an object that is gone.
    for (const [table, column] of [
      ['activity_link', 'entity_type'],
      ['task', 'entity_type'],
      ['attachment', 'entity_type'],
      ['association', 'from_type'],
      ['association', 'to_type'],
    ]) {
      const [{ n: left = 0 } = { n: 0 }] = await db.execute<{ n: number }>(
        `select count(*)::int as n from ${table} where ${column} = '${key}'` as never,
      )
      expect(Number(left) === 0, `${left} rows left in ${table}.${column}`)
    }

    // The note written on it went with its last link, rather than being left as
    // history of nothing.
    const [{ n: notes = 0 } = { n: 0 }] = await db.execute<{ n: number }>(
      `select count(*)::int as n from activity where body = 'Kicked off with the client.'` as never,
    )
    expect(Number(notes) === 0, `${notes} orphaned activities survived`)

    forgetRegistry(ctx.accountId)
    expect(!(await getRegistry(ctx)).byKey.has(key), 'it is still in the registry')
    return 'gone, with its links, the way dropping a table would have taken them'
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
  // Leave nothing behind, whatever happened above. By key rather than by
  // is_custom: the seed invents one of its own, and taking every custom object
  // emptied it out from under the next suite.
  await db.execute(`delete from object_def where key = 'project' and is_custom = true and account_id = '${ws!.id}'` as never)
  await closeAppPool()
  await owner.end()
  await cleanup()
}
