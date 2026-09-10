import { and, asc, eq, isNull, sql, type Column, type SQL } from 'drizzle-orm'
import { fieldDef, objectDef } from '../schema/metadata.ts'
import { readConditional, type Conditional } from '../registry/conditional.ts'
import { TYPE_META, type FieldType, type Operator } from '../registry/types.ts'
import type { ObjectKey } from '../registry/core.ts'
import type { AccountContext } from './context.ts'
import { withAccount, type Tx } from './index.ts'
import { assertUsableFieldKey } from './fields.ts'

export const OBJECT_KEYS = ['contact', 'company', 'deal'] as const

export const isObjectKey = (value: string): value is ObjectKey =>
  (OBJECT_KEYS as readonly string[]).includes(value)

/** What an invented object key may be. It reaches SQL as a jsonb key and appears
 *  in a URL, so it is the same alphabet a field key is held to and nothing else. */
const USABLE_OBJECT_KEY = /^[a-z][a-z0-9_]{1,58}$/

/** Fields the system owns. They are in the registry because every surface has to
 *  be able to read, sort, filter and export them, and they are refused on the write
 *  path because nobody may hand-edit when a record was created. Kept here rather
 *  than as a column on field_def: the set is fixed by what the database itself
 *  maintains, not by anything an admin configures. */
export const SYSTEM_FIELD_KEYS: ReadonlySet<string> = new Set([
  'created_at',
  'last_contacted_at',
  'last_replied_at',
  'emails_sent',
  'emails_received',
  'score',
])

export type RegistryField = {
  id: string
  key: string
  label: string
  type: FieldType
  storage: 'column' | 'jsonb'
  columnName: string | null
  isRequired: boolean
  isCustom: boolean
  /** Readable and filterable everywhere, refused on every write path. */
  isSystem: boolean
  trackChanges: boolean
  options: string[]
  helpText: string | null
  position: number
  operators: readonly Operator[]
  /** While this does not match the record's other values, the field is not on the
   *  record. Null is a field that is always there. */
  conditional: Conditional | null
}

export type RegistryObject = {
  id: string
  /** Not `ObjectKey`: an admin can invent one. `ObjectKey` still names the three
   *  the system builds on — the ones with associations, activities and tasks —
   *  and `isCoreObject` below is how a caller asks whether this is one. */
  key: string
  nameSingular: string
  namePlural: string
  icon: string | null
  /** Invented by an admin. Its rows live in the shared `custom_record` table
   *  rather than in one of its own, so every value is in the jsonb blob and no
   *  field of it can be promoted to a hot column. */
  isCustom: boolean
  /** The physical table its rows are in. For the core three this is the key; for
   *  a custom object it is `custom_record`, and `scope` below is the extra
   *  predicate that keeps one object's rows apart from another's. */
  table: string
  /** Which field is the record's name. Null on the core three, which each know
   *  their own naming rule. */
  labelFieldKey: string | null
  fields: RegistryField[]
  byKey: Map<string, RegistryField>
}

export type Registry = {
  objects: RegistryObject[]
  byKey: Map<string, RegistryObject>
}

/** One of the three the system is built on. They have their own tables, and they
 *  are the only things an association, an activity or a task can point at. */
export const isCoreObject = (object: RegistryObject): object is RegistryObject & { key: ObjectKey } =>
  !object.isCustom

/** Per account, short lived. The registry changes only when an admin edits a
 *  field, which is rare, but a stale cache would show the wrong columns, so the
 *  entry is dropped on any field write rather than left to expire. */
const cache = new Map<string, { at: number; registry: Registry }>()
const TTL_MS = 30_000

export const forgetRegistry = (accountId: string): void => {
  cache.delete(accountId)
}

const load = async (tx: Tx): Promise<Registry> => {
  const rows = await tx
    .select({
      objectId: objectDef.id,
      objectKey: objectDef.key,
      nameSingular: objectDef.nameSingular,
      namePlural: objectDef.namePlural,
      icon: objectDef.icon,
      // Both object_def and field_def have an is_custom; this one is the
      // object's, and the field's keeps the plain name below.
      objectIsCustom: objectDef.isCustom,
      labelFieldId: objectDef.labelFieldId,
      fieldId: fieldDef.id,
      key: fieldDef.key,
      label: fieldDef.label,
      type: fieldDef.type,
      storage: fieldDef.storage,
      columnName: fieldDef.columnName,
      isRequired: fieldDef.isRequired,
      isCustom: fieldDef.isCustom,
      trackChanges: fieldDef.trackChanges,
      options: fieldDef.options,
      helpText: fieldDef.helpText,
      position: fieldDef.position,
      conditional: fieldDef.conditional,
    })
    .from(objectDef)
    .leftJoin(
      fieldDef,
      and(eq(fieldDef.objectId, objectDef.id), isNull(fieldDef.deletedAt)),
    )
    .orderBy(asc(objectDef.key), asc(fieldDef.position))

  const objects = new Map<string, RegistryObject>()
  const labelFieldIds = new Map<string, string>()
  for (const row of rows) {
    // A key that is neither one of the three nor a usable identifier is dropped:
    // it reaches SQL as a table name or a jsonb key, and nothing unchecked does.
    const custom = row.objectIsCustom === true
    if (!custom && !isObjectKey(row.objectKey)) continue
    if (custom && !USABLE_OBJECT_KEY.test(row.objectKey)) continue

    let object = objects.get(row.objectId)
    if (!object) {
      object = {
        id: row.objectId,
        key: row.objectKey,
        nameSingular: row.nameSingular,
        namePlural: row.namePlural,
        icon: row.icon,
        isCustom: custom,
        table: custom ? 'custom_record' : row.objectKey,
        labelFieldKey: null,
        fields: [],
        byKey: new Map(),
      }
      objects.set(row.objectId, object)
      if (row.labelFieldId) labelFieldIds.set(row.objectId, row.labelFieldId)
    }
    if (!row.fieldId || !row.key) continue
    const field: RegistryField = {
      id: row.fieldId,
      key: row.key,
      label: row.label ?? row.key,
      type: row.type as FieldType,
      storage: row.storage as 'column' | 'jsonb',
      columnName: row.columnName,
      isRequired: row.isRequired ?? false,
      isCustom: row.isCustom ?? true,
      isSystem: SYSTEM_FIELD_KEYS.has(row.key),
      trackChanges: row.trackChanges ?? false,
      options: Array.isArray(row.options) ? (row.options as string[]) : [],
      helpText: row.helpText,
      position: row.position ?? 0,
      operators: TYPE_META[row.type as FieldType].operators,
      conditional: readConditional(row.conditional),
    }
    object.fields.push(field)
    object.byKey.set(field.key, field)
  }

  // Resolved after the fields are loaded, because the label field is one of
  // them and the rows arrive in no guaranteed order.
  for (const object of objects.values()) {
    const wanted = labelFieldIds.get(object.id)
    const named = wanted ? object.fields.find((field) => field.id === wanted) : undefined
    // Falling back to the first field means a custom object always has something
    // to be called, even one whose label field was deleted.
    object.labelFieldKey = named?.key ?? object.fields[0]?.key ?? null
  }

  // The order every surface reads objects in: the navigation, the association
  // rail, the search results, the object argument an agent is offered. The three
  // the system is built on keep the order they are always named in, and invented
  // ones follow alphabetically. The query orders by key, which would put a
  // company before a contact and an "Asset" before both.
  const list = [...objects.values()].sort((a, b) => {
    const rank = (object: RegistryObject) => {
      const index = (OBJECT_KEYS as readonly string[]).indexOf(object.key)
      return index === -1 ? OBJECT_KEYS.length : index
    }
    return rank(a) - rank(b) || a.namePlural.localeCompare(b.namePlural)
  })
  return { objects: list, byKey: new Map(list.map((o) => [o.key, o])) }
}

export const getRegistry = async (ctx: AccountContext): Promise<Registry> => {
  const hit = cache.get(ctx.accountId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.registry
  const registry = await withAccount(ctx, load)
  cache.set(ctx.accountId, { at: Date.now(), registry })
  return registry
}

/** Reads the registry inside a transaction the caller already opened, so a write
 *  path does not need a second round trip or a second account context. */
export const getRegistryIn = async (tx: Tx): Promise<Registry> => load(tx)

export class UnknownFieldError extends Error {
  constructor(objectKey: string, fieldKey: string) {
    super(`${objectKey} has no field called "${fieldKey}" in this account.`)
    this.name = 'UnknownFieldError'
  }
}

/** Whether the record an `(entity_type, entity_id)` pair names is still there.
 *
 *  Four tables hold records and no constraint spans them, so "does this still
 *  exist" is a case over the type. Written once because four surfaces need the
 *  same answer: a task keeps its place in the list when its record goes, a note
 *  stops being offered by search, and a page view or a notification stops
 *  pointing at a page that has been deleted.
 *
 *  Existence, never a name: a contact with neither a name nor an email is
 *  nameless and still real, and reading the name as a proxy retired those. */
export const entityAlive = (type: SQL | Column, id: SQL | Column): SQL<boolean> => sql<boolean>`case
  when ${type} = 'contact' then exists (select 1 from contact x where x.id = ${id} and x.deleted_at is null)
  when ${type} = 'company' then exists (select 1 from company x where x.id = ${id} and x.deleted_at is null)
  when ${type} = 'deal' then exists (select 1 from deal x where x.id = ${id} and x.deleted_at is null)
  when ${type} is null then false
  else exists (select 1 from custom_record x join object_def o on o.id = x.object_id
                where x.id = ${id} and o.key = ${type} and x.deleted_at is null)
end`

export const objectOrThrow = (registry: Registry, key: string): RegistryObject => {
  const object = registry.byKey.get(key)
  if (!object) throw new Error(`"${key}" is not an object in this account.`)
  return object
}

/** The object's key, when it is one of the three the system is built on.
 *
 *  Activities, activity links, associations and tasks all point at an
 *  `entityType`, which is an enum of exactly those three. A custom object has
 *  none of them yet, so a path that needs one asks here and skips rather than
 *  writing a row the enum cannot hold. */
export const coreKeyOf = (object: RegistryObject): ObjectKey | null =>
  object.isCustom ? null : (object.key as ObjectKey)

/** For a path that cannot work at all without them, and should say so rather
 *  than half-run. */
export const assertCore = (object: RegistryObject, what: string): ObjectKey => {
  const key = coreKeyOf(object)
  if (!key) {
    throw new Error(
      `${object.namePlural} cannot ${what} yet. That is only for contacts, companies and deals.`,
    )
  }
  return key
}

/** The FROM clause for an object's rows.
 *
 *  Aliased to the object's key, which is the whole trick: a custom object's rows
 *  are in `custom_record`, but `from custom_record as "project"` means every
 *  expression built elsewhere — `"project"."custom" ->> 'status'`, the filters,
 *  the sorts — is the same string it would be for a table of its own. Nothing
 *  downstream of here has to know which kind of object it is looking at. */
export const tableFor = (object: RegistryObject): SQL =>
  object.isCustom
    ? sql.raw(`"custom_record" as "${object.key}"`)
    : sql.raw(`"${object.key}"`)

/** What keeps one custom object's rows apart from another's, and nothing for a
 *  core object, which has a table to itself. Always joined with `and`, so the
 *  core case has to be the identity rather than a missing clause.
 *
 *  Named for the rows rather than `scopeFor`, which in query.ts already means
 *  the person a saved filter's "@me" resolves to. */
export const rowsOf = (object: RegistryObject): SQL =>
  object.isCustom
    ? sql`${sql.raw(`"${object.key}"."object_id"`)} = ${object.id}::uuid`
    : sql`true`

export const fieldOrThrow = (object: RegistryObject, key: string): RegistryField => {
  const field = object.byKey.get(key)
  if (!field) throw new UnknownFieldError(object.key, key)
  // Everything that can reach an identifier in SQL passes this, including the
  // column name a column-stored field resolves to.
  assertUsableFieldKey(field.key)
  if (field.storage === 'column') {
    // A custom object has no columns of its own: its rows share one table, so a
    // column-stored field on one would be a column on everybody's.
    if (object.isCustom) {
      throw new Error(`${object.key}.${field.key} cannot be a column: a custom object stores every value in its blob.`)
    }
    if (!field.columnName) {
      throw new Error(`${object.key}.${field.key} claims column storage but has no column.`)
    }
    assertUsableFieldKey(field.columnName)
  }
  return field
}
