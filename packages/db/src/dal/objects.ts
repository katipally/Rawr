import { and, asc, eq, sql } from 'drizzle-orm'
import { fieldDef, objectDef } from '../schema/metadata.ts'
import { customRecord } from '../schema/records.ts'
import type { WorkspaceContext } from './context.ts'
import { forgetRegistry, OBJECT_KEYS } from './registry.ts'
import { mutate, withWorkspace } from './index.ts'

/** Objects an admin invents.
 *
 *  The definition has always had a home in `object_def`; what was missing was
 *  anywhere to put the rows, which is `custom_record`. This is the small amount
 *  of code that creates one and takes it away again.
 *
 *  A custom object now carries what a core one does: records, fields, a list, a
 *  record page, a timeline, associations, tasks and files. What stays core-only
 *  is the handful of paths that know a specific shape rather than a general one:
 *  merging two records, enriching from a domain, and importing a file. Those say
 *  so through `assertCore` rather than half-running. */

export type CustomObjectRow = {
  id: string
  key: string
  nameSingular: string
  namePlural: string
  icon: string | null
  fieldCount: number
  recordCount: number
}

/** Reaches SQL as a jsonb key and a URL segment, so the same alphabet a field key
 *  is held to. Leading letter, because a key starting with a digit is a key that
 *  has to be quoted everywhere it appears. */
const USABLE_KEY = /^[a-z][a-z0-9_]{1,58}$/

/** The words a person types, turned into the key they never see. Made once, at
 *  creation, and never again: renaming the label must not touch stored data,
 *  which is the same rule a field key follows. */
export const objectKeyFrom = (name: string): string =>
  name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'o$1')
    .slice(0, 58)

/** Names Postgres or Rawr already means something by. A custom object called
 *  `contact` would shadow a core one in every registry lookup. */
const RESERVED = new Set([
  ...OBJECT_KEYS,
  'custom_record',
  'workspace',
  'user_account',
  'activity',
  'task',
  'segment',
  'form',
  'booking',
  'sequence',
  'attachment',
])

export const listCustomObjects = async (ctx: WorkspaceContext): Promise<CustomObjectRow[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      key: string
      name_singular: string
      name_plural: string
      icon: string | null
      fields: number
      records: number
    }>(sql`
      select o.id, o.key, o.name_singular, o.name_plural, o.icon,
             count(distinct f.id)::int as fields,
             count(distinct r.id)::int as records
        from object_def o
        left join field_def f on f.object_id = o.id and f.deleted_at is null
        left join custom_record r on r.object_id = o.id and r.deleted_at is null
       where o.is_custom = true
       group by o.id
       order by o.name_plural`)
    return rows.map((row) => ({
      id: String(row.id),
      key: String(row.key),
      nameSingular: String(row.name_singular),
      namePlural: String(row.name_plural),
      icon: row.icon,
      fieldCount: Number(row.fields),
      recordCount: Number(row.records),
    }))
  })

export type CreateObjectInput = {
  nameSingular: string
  namePlural: string
  /** The field every record of this object is called by. Created with it, because
   *  an object whose records have no name is a list of uuids. */
  labelFieldLabel?: string | undefined
  icon?: string | null | undefined
}

export const createCustomObject = async (
  ctx: WorkspaceContext,
  input: CreateObjectInput,
): Promise<{ id: string; key: string }> =>
  mutate(ctx, 'object_def', async (tx) => {
    const nameSingular = input.nameSingular.trim()
    const namePlural = input.namePlural.trim()
    if (!nameSingular || !namePlural) throw new Error('An object needs a singular and a plural name.')

    const key = objectKeyFrom(nameSingular)
    if (!USABLE_KEY.test(key)) {
      throw new Error(`"${nameSingular}" does not make a usable key. Use letters and numbers.`)
    }
    if (RESERVED.has(key)) throw new Error(`"${key}" is a name Rawr already uses. Pick another.`)

    const [existing] = await tx
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.key, key))
      .limit(1)
    if (existing) throw new Error(`There is already an object called "${nameSingular}".`)

    const [created] = await tx
      .insert(objectDef)
      .values({ workspaceId: ctx.workspaceId, key, nameSingular, namePlural, isCustom: true, icon: input.icon ?? null })
      .returning({ id: objectDef.id })
    if (!created) throw new Error('The object could not be created.')

    // Every custom object gets its naming field with it. Storage is jsonb, and
    // has to be: its rows share a table, so a column of its own would be a
    // column on every other custom object too.
    const [labelField] = await tx
      .insert(fieldDef)
      .values({
        workspaceId: ctx.workspaceId,
        objectId: created.id,
        key: 'name',
        label: (input.labelFieldLabel ?? 'Name').trim() || 'Name',
        type: 'text',
        storage: 'jsonb',
        isRequired: true,
        isCustom: true,
        position: 0,
      })
      .returning({ id: fieldDef.id })
    if (labelField) {
      await tx.update(objectDef).set({ labelFieldId: labelField.id }).where(eq(objectDef.id, created.id))
    }

    forgetRegistry(ctx.workspaceId)
    return {
      result: { id: created.id, key },
      audit: { entity: 'object_def', entityId: created.id, action: 'create', before: null, after: { key, nameSingular, namePlural } },
    }
  })

/** Takes the object and everything that was one of it.
 *
 *  Hard, not soft. A soft-deleted object would still occupy its key, still be in
 *  every registry read, and still have to be filtered out of every list — which
 *  is most of the cost of having it with none of the use. The records go by
 *  cascade, the way dropping a table would have taken them. */
export const deleteCustomObject = async (ctx: WorkspaceContext, id: string): Promise<void> =>
  mutate(ctx, 'object_def', async (tx) => {
    const [before] = await tx
      .select({ key: objectDef.key, nameSingular: objectDef.nameSingular, isCustom: objectDef.isCustom })
      .from(objectDef)
      .where(eq(objectDef.id, id))
      .limit(1)
    if (!before) throw new Error('That object no longer exists.')
    if (!before.isCustom) throw new Error(`${before.nameSingular} is one of the objects Rawr is built on and cannot be deleted.`)

    const [{ n = 0 } = { n: 0 }] = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from custom_record where object_id = ${id}::uuid and deleted_at is null`,
    )

    // What pointed at those records by key. None of these is a foreign key, so
    // the cascade that takes the rows cannot take these with it, and a link left
    // behind would be a card on some other record naming an object that is gone.
    for (const statement of [
      sql`delete from association where from_type = ${before.key} or to_type = ${before.key}`,
      sql`delete from task where entity_type = ${before.key}`,
      sql`delete from attachment where entity_type = ${before.key}`,
      sql`delete from automation_run where entity_type = ${before.key}`,
    ]) {
      await tx.execute(statement)
    }

    // An activity is written once and linked to every record it touches. Taking
    // its last link leaves history of nothing, so the two go together; one that
    // also sat on a contact keeps that link and stays.
    //
    // Three statements rather than one with a data-modifying CTE: the outer half
    // of such a statement reads the snapshot from before the CTE ran, so it would
    // still see the links this one just deleted and delete nothing.
    const touched = await tx.execute<{ activity_id: string }>(
      sql`delete from activity_link where entity_type = ${before.key} returning activity_id`,
    )
    if (touched.length > 0) {
      const ids = [...new Set(touched.map((row) => row.activity_id))]
      await tx.execute(sql`
        delete from activity a
         where a.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
           and not exists (select 1 from activity_link l where l.activity_id = a.id)`)
    }

    await tx.delete(objectDef).where(eq(objectDef.id, id))
    forgetRegistry(ctx.workspaceId)
    return {
      result: undefined,
      audit: {
        entity: 'object_def',
        entityId: id,
        action: 'delete',
        before: { ...before, records: n },
        after: null,
      },
    }
  })

export const renameCustomObject = async (
  ctx: WorkspaceContext,
  id: string,
  input: { nameSingular: string; namePlural: string },
): Promise<void> =>
  mutate(ctx, 'object_def', async (tx) => {
    const [before] = await tx
      .select({ nameSingular: objectDef.nameSingular, namePlural: objectDef.namePlural, isCustom: objectDef.isCustom })
      .from(objectDef)
      .where(eq(objectDef.id, id))
      .limit(1)
    if (!before) throw new Error('That object no longer exists.')
    if (!before.isCustom) throw new Error('The objects Rawr is built on cannot be renamed.')

    const nameSingular = input.nameSingular.trim()
    const namePlural = input.namePlural.trim()
    if (!nameSingular || !namePlural) throw new Error('An object needs a singular and a plural name.')

    // The key is untouched on purpose: it is in every saved view's address and in
    // every stored filter, and renaming a label must never move stored data.
    await tx.update(objectDef).set({ nameSingular, namePlural }).where(eq(objectDef.id, id))
    forgetRegistry(ctx.workspaceId)
    return {
      result: undefined,
      audit: { entity: 'object_def', entityId: id, action: 'rename', before, after: { nameSingular, namePlural } },
    }
  })
