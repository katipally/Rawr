import { and, asc, eq, isNull } from 'drizzle-orm'
import { fieldDef, objectDef } from '../schema/metadata.ts'
import { TYPE_META, type FieldType, type Operator } from '../registry/types.ts'
import type { ObjectKey } from '../registry/core.ts'
import type { WorkspaceContext } from './context.ts'
import { withWorkspace, type Tx } from './index.ts'
import { assertUsableFieldKey } from './fields.ts'

export const OBJECT_KEYS = ['contact', 'company', 'deal'] as const

export const isObjectKey = (value: string): value is ObjectKey =>
  (OBJECT_KEYS as readonly string[]).includes(value)

export type RegistryField = {
  id: string
  key: string
  label: string
  type: FieldType
  storage: 'column' | 'jsonb'
  columnName: string | null
  isRequired: boolean
  isCustom: boolean
  trackChanges: boolean
  options: string[]
  helpText: string | null
  position: number
  operators: readonly Operator[]
}

export type RegistryObject = {
  id: string
  key: ObjectKey
  nameSingular: string
  namePlural: string
  icon: string | null
  fields: RegistryField[]
  byKey: Map<string, RegistryField>
}

export type Registry = {
  objects: RegistryObject[]
  byKey: Map<ObjectKey, RegistryObject>
}

/** Per workspace, short lived. The registry changes only when an admin edits a
 *  field, which is rare, but a stale cache would show the wrong columns, so the
 *  entry is dropped on any field write rather than left to expire. */
const cache = new Map<string, { at: number; registry: Registry }>()
const TTL_MS = 30_000

export const forgetRegistry = (workspaceId: string): void => {
  cache.delete(workspaceId)
}

const load = async (tx: Tx): Promise<Registry> => {
  const rows = await tx
    .select({
      objectId: objectDef.id,
      objectKey: objectDef.key,
      nameSingular: objectDef.nameSingular,
      namePlural: objectDef.namePlural,
      icon: objectDef.icon,
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
    })
    .from(objectDef)
    .leftJoin(
      fieldDef,
      and(eq(fieldDef.objectId, objectDef.id), isNull(fieldDef.deletedAt)),
    )
    .orderBy(asc(objectDef.key), asc(fieldDef.position))

  const objects = new Map<string, RegistryObject>()
  for (const row of rows) {
    if (!isObjectKey(row.objectKey)) continue
    let object = objects.get(row.objectId)
    if (!object) {
      object = {
        id: row.objectId,
        key: row.objectKey,
        nameSingular: row.nameSingular,
        namePlural: row.namePlural,
        icon: row.icon,
        fields: [],
        byKey: new Map(),
      }
      objects.set(row.objectId, object)
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
      trackChanges: row.trackChanges ?? false,
      options: Array.isArray(row.options) ? (row.options as string[]) : [],
      helpText: row.helpText,
      position: row.position ?? 0,
      operators: TYPE_META[row.type as FieldType].operators,
    }
    object.fields.push(field)
    object.byKey.set(field.key, field)
  }

  const list = [...objects.values()]
  return { objects: list, byKey: new Map(list.map((o) => [o.key, o])) }
}

export const getRegistry = async (ctx: WorkspaceContext): Promise<Registry> => {
  const hit = cache.get(ctx.workspaceId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.registry
  const registry = await withWorkspace(ctx, load)
  cache.set(ctx.workspaceId, { at: Date.now(), registry })
  return registry
}

/** Reads the registry inside a transaction the caller already opened, so a write
 *  path does not need a second round trip or a second workspace context. */
export const getRegistryIn = async (tx: Tx): Promise<Registry> => load(tx)

export class UnknownFieldError extends Error {
  constructor(objectKey: string, fieldKey: string) {
    super(`${objectKey} has no field called "${fieldKey}" in this workspace.`)
    this.name = 'UnknownFieldError'
  }
}

export const objectOrThrow = (registry: Registry, key: string): RegistryObject => {
  const object = isObjectKey(key) ? registry.byKey.get(key) : undefined
  if (!object) throw new Error(`"${key}" is not an object in this workspace.`)
  return object
}

export const fieldOrThrow = (object: RegistryObject, key: string): RegistryField => {
  const field = object.byKey.get(key)
  if (!field) throw new UnknownFieldError(object.key, key)
  // Everything that can reach an identifier in SQL passes this, including the
  // column name a column-stored field resolves to.
  assertUsableFieldKey(field.key)
  if (field.storage === 'column') {
    if (!field.columnName) {
      throw new Error(`${object.key}.${field.key} claims column storage but has no column.`)
    }
    assertUsableFieldKey(field.columnName)
  }
  return field
}
