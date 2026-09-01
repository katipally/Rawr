import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { fieldDef, fieldIndex, objectDef } from '../schema/metadata.ts'
import { FIELD_TYPES, TYPE_META, type FieldType } from '../registry/types.ts'
import type { WorkspaceContext } from './context.ts'
import { assertUsableFieldKey } from './fields.ts'
import { mutate, withWorkspace, type Tx } from './index.ts'
import { forgetRegistry, SYSTEM_FIELD_KEYS } from './registry.ts'

/** The write side of the metadata registry. D4's whole premise is that marketing
 *  can add a property without a deploy, and that only holds if there is somewhere
 *  to add it from.
 *
 *  Every field created here is stored in <object>.custom as jsonb, because that is
 *  what a custom field is. Promotion to a real column stays a migration plus a
 *  registry flag behind the same API, exactly as D4 describes; nothing here emits
 *  DDL. The one DDL path in the project remains the hot-index job. */

export type AdminField = {
  id: string
  objectKey: string
  key: string
  label: string
  type: FieldType
  storage: 'column' | 'jsonb'
  isRequired: boolean
  isCustom: boolean
  isSystem: boolean
  isHot: boolean
  options: string[]
  helpText: string | null
  position: number
  trackChanges: boolean
  /** Set once a hot index has been asked for, so the UI can show its state. */
  indexState: string | null
  /** How many records currently hold a value, so a delete can say what is at stake. */
  filledCount: number | null
}

const OPTION_TYPES = new Set<FieldType>(['select', 'multi_select'])

export const listFields = async (ctx: WorkspaceContext, objectKey?: string): Promise<AdminField[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: fieldDef.id,
        objectKey: objectDef.key,
        key: fieldDef.key,
        label: fieldDef.label,
        type: fieldDef.type,
        storage: fieldDef.storage,
        isRequired: fieldDef.isRequired,
        isCustom: fieldDef.isCustom,
        isHot: fieldDef.isHot,
        options: fieldDef.options,
        helpText: fieldDef.helpText,
        position: fieldDef.position,
        trackChanges: fieldDef.trackChanges,
        indexState: fieldIndex.state,
      })
      .from(fieldDef)
      .innerJoin(objectDef, eq(objectDef.id, fieldDef.objectId))
      .leftJoin(fieldIndex, eq(fieldIndex.fieldId, fieldDef.id))
      .where(
        and(
          isNull(fieldDef.deletedAt),
          objectKey ? eq(objectDef.key, objectKey) : undefined,
        ),
      )
      .orderBy(asc(objectDef.key), asc(fieldDef.position))

    return rows.map((row) => ({
      id: row.id,
      objectKey: row.objectKey,
      key: row.key,
      label: row.label,
      type: row.type as FieldType,
      storage: row.storage as 'column' | 'jsonb',
      isRequired: row.isRequired,
      isCustom: row.isCustom,
      isSystem: SYSTEM_FIELD_KEYS.has(row.key),
      isHot: row.isHot,
      options: Array.isArray(row.options) ? (row.options as string[]) : [],
      helpText: row.helpText,
      position: row.position,
      trackChanges: row.trackChanges,
      indexState: row.indexState ?? null,
      filledCount: null,
    }))
  })

const objectRow = async (tx: Tx, objectKey: string): Promise<{ id: string; key: string }> => {
  const [found] = await tx
    .select({ id: objectDef.id, key: objectDef.key })
    .from(objectDef)
    .where(eq(objectDef.key, objectKey))
    .limit(1)
  if (!found) throw new Error(`This workspace has no object called "${objectKey}".`)
  return found
}

const validateOptions = (type: FieldType, options: string[]): string[] => {
  if (!OPTION_TYPES.has(type)) return []
  const cleaned = [...new Set(options.map((option) => option.trim()).filter(Boolean))]
  if (cleaned.length === 0) {
    throw new Error('A choice field needs at least one choice.')
  }
  if (cleaned.length > 200) {
    throw new Error(`That is ${cleaned.length} choices; 200 is the limit. A list that long wants to be a relation.`)
  }
  return cleaned
}

export type CreateFieldInput = {
  objectKey: string
  key: string
  label: string
  type: FieldType
  options?: string[]
  helpText?: string | null
  isRequired?: boolean
  trackChanges?: boolean
}

/** A new field is always jsonb-stored and always custom. The key is generated once
 *  and never changes, because renaming a label must never touch data. F0 §4. */
export const createField = async (ctx: WorkspaceContext, input: CreateFieldInput): Promise<AdminField> =>
  mutate(ctx, 'field_def', async (tx) => {
    const object = await objectRow(tx, input.objectKey)
    const key = input.key.trim().toLowerCase()
    assertUsableFieldKey(key)
    if (SYSTEM_FIELD_KEYS.has(key)) {
      throw new Error(`"${key}" is a name Rawr uses for itself. Pick another.`)
    }
    if (!FIELD_TYPES.includes(input.type)) {
      throw new Error(`"${input.type}" is not a field type. Pick one of: ${FIELD_TYPES.join(', ')}.`)
    }
    const label = input.label.trim()
    if (label === '') throw new Error('A field needs a label.')

    // Including soft-deleted rows: the key is still occupied until it is purged,
    // and reusing it would resurrect old values under a new definition.
    const [clash] = await tx
      .select({ id: fieldDef.id, deletedAt: fieldDef.deletedAt })
      .from(fieldDef)
      .where(and(eq(fieldDef.objectId, object.id), eq(fieldDef.key, key)))
      .limit(1)
    if (clash) {
      throw new Error(
        clash.deletedAt
          ? `${object.key} had a field called "${key}" that was deleted but not purged. Purge it first, or pick another name.`
          : `${object.key} already has a field called "${key}".`,
      )
    }

    const [{ next = 0 } = { next: 0 }] = await tx.execute<{ next: number }>(
      sql`select coalesce(max(position), -1) + 1 as next from field_def where object_id = ${object.id}`,
    )

    const [created] = await tx
      .insert(fieldDef)
      .values({
        workspaceId: ctx.workspaceId,
        objectId: object.id,
        key,
        label,
        type: input.type,
        storage: 'jsonb',
        columnName: null,
        isCustom: true,
        isRequired: input.isRequired ?? false,
        trackChanges: input.trackChanges ?? false,
        options: validateOptions(input.type, input.options ?? []),
        helpText: input.helpText?.trim() || null,
        position: Number(next),
      })
      .returning({ id: fieldDef.id })
    if (!created) throw new Error('The field could not be created.')

    forgetRegistry(ctx.workspaceId)

    return {
      result: {
        id: created.id,
        objectKey: object.key,
        key,
        label,
        type: input.type,
        storage: 'jsonb' as const,
        isRequired: input.isRequired ?? false,
        isCustom: true,
        isSystem: false,
        isHot: false,
        options: validateOptions(input.type, input.options ?? []),
        helpText: input.helpText?.trim() || null,
        position: Number(next),
        trackChanges: input.trackChanges ?? false,
        indexState: null,
        filledCount: null,
      },
      audit: {
        entity: 'field_def',
        entityId: created.id,
        action: 'create',
        before: null,
        after: { objectKey: object.key, key, label, type: input.type },
      },
    }
  })

export type UpdateFieldInput = {
  id: string
  label?: string
  options?: string[]
  helpText?: string | null
  isRequired?: boolean
  trackChanges?: boolean
}

/** Label, help text, choices and the two flags. The key and the type are not here
 *  on purpose: both would change what stored values mean, and a field whose meaning
 *  changed under the data is worse than a second field. */
export const updateField = async (ctx: WorkspaceContext, input: UpdateFieldInput): Promise<void> =>
  mutate(ctx, 'field_def', async (tx) => {
    const [before] = await tx
      .select({
        key: fieldDef.key,
        label: fieldDef.label,
        type: fieldDef.type,
        options: fieldDef.options,
        helpText: fieldDef.helpText,
        isRequired: fieldDef.isRequired,
        trackChanges: fieldDef.trackChanges,
      })
      .from(fieldDef)
      .where(and(eq(fieldDef.id, input.id), isNull(fieldDef.deletedAt)))
      .limit(1)
    if (!before) throw new Error('That field does not exist, or it has been deleted.')
    if (SYSTEM_FIELD_KEYS.has(before.key)) {
      throw new Error(`${before.label} is maintained by Rawr and cannot be changed.`)
    }

    const label = input.label?.trim()
    if (input.label !== undefined && !label) throw new Error('A field needs a label.')

    await tx
      .update(fieldDef)
      .set({
        ...(label ? { label } : {}),
        ...(input.options ? { options: validateOptions(before.type as FieldType, input.options) } : {}),
        ...(input.helpText !== undefined ? { helpText: input.helpText?.trim() || null } : {}),
        ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
        ...(input.trackChanges !== undefined ? { trackChanges: input.trackChanges } : {}),
      })
      .where(eq(fieldDef.id, input.id))

    forgetRegistry(ctx.workspaceId)

    return {
      result: undefined,
      audit: {
        entity: 'field_def',
        entityId: input.id,
        action: 'update',
        before,
        after: input,
      },
    }
  })

/** Order is what the record page and the picker read, so moving a field is a real
 *  edit rather than a display preference. Positions are rewritten densely so a
 *  long-lived workspace never accumulates gaps. */
export const reorderFields = async (
  ctx: WorkspaceContext,
  objectKey: string,
  orderedIds: string[],
): Promise<void> =>
  mutate(ctx, 'field_def', async (tx) => {
    const object = await objectRow(tx, objectKey)
    const rows = await tx
      .select({ id: fieldDef.id })
      .from(fieldDef)
      .where(and(eq(fieldDef.objectId, object.id), isNull(fieldDef.deletedAt)))

    const known = new Set(rows.map((row) => row.id))
    const unknown = orderedIds.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      throw new Error(`${unknown.length} of those fields are not on ${object.key}.`)
    }
    // Anything not named keeps its relative order behind the named ones, so a
    // partial reorder cannot silently drop a field off the end of the list.
    const rest = rows.map((row) => row.id).filter((id) => !orderedIds.includes(id))

    let position = 0
    for (const id of [...orderedIds, ...rest]) {
      await tx.update(fieldDef).set({ position: position++ }).where(eq(fieldDef.id, id))
    }

    forgetRegistry(ctx.workspaceId)

    return {
      result: undefined,
      audit: {
        entity: 'field_def',
        entityId: object.id,
        action: 'reorder',
        before: { count: rows.length },
        after: { order: orderedIds },
      },
    }
  })

export type FieldUsage = { filled: number; label: string; key: string; objectKey: string }

/** How many records hold a value, so a delete confirmation can say what is at stake
 *  rather than asking somebody to guess. */
export const fieldUsage = async (ctx: WorkspaceContext, fieldId: string): Promise<FieldUsage> =>
  withWorkspace(ctx, async (tx) => {
    const [found] = await tx
      .select({
        key: fieldDef.key,
        label: fieldDef.label,
        storage: fieldDef.storage,
        columnName: fieldDef.columnName,
        objectKey: objectDef.key,
      })
      .from(fieldDef)
      .innerJoin(objectDef, eq(objectDef.id, fieldDef.objectId))
      .where(eq(fieldDef.id, fieldId))
      .limit(1)
    if (!found) throw new Error('That field does not exist in this workspace.')

    assertUsableFieldKey(found.key)
    assertUsableFieldKey(found.objectKey)
    const table = sql.raw(`"${found.objectKey}"`)
    const predicate =
      found.storage === 'column' && found.columnName
        ? sql.raw(`"${found.columnName}" is not null`)
        : sql.raw(`custom ? '${found.key}' and custom ->> '${found.key}' is not null`)

    const [row] = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from ${table} where deleted_at is null and ${predicate}`,
    )
    return { filled: Number(row?.n ?? 0), key: found.key, label: found.label, objectKey: found.objectKey }
  })

/** Phase one of two. The field disappears from every surface immediately and the
 *  data stays exactly where it was, so a misclick costs nothing. F0 §4. */
export const deleteField = async (ctx: WorkspaceContext, fieldId: string): Promise<void> =>
  mutate(ctx, 'field_def', async (tx) => {
    const [found] = await tx
      .select({ key: fieldDef.key, label: fieldDef.label, isCustom: fieldDef.isCustom, storage: fieldDef.storage })
      .from(fieldDef)
      .where(and(eq(fieldDef.id, fieldId), isNull(fieldDef.deletedAt)))
      .limit(1)
    if (!found) throw new Error('That field does not exist, or it has already been deleted.')
    if (!found.isCustom || found.storage !== 'jsonb') {
      throw new Error(
        `${found.label} is a core field. Core fields have their own column and their own meaning across the product, so they cannot be deleted.`,
      )
    }

    await tx.update(fieldDef).set({ deletedAt: new Date() }).where(eq(fieldDef.id, fieldId))
    // A hot index on a field nobody can see is dead weight, and the field may be
    // restored, so the record goes and the index is rebuilt if it comes back.
    await tx.update(fieldDef).set({ isHot: false }).where(eq(fieldDef.id, fieldId))
    await tx.delete(fieldIndex).where(eq(fieldIndex.fieldId, fieldId))

    forgetRegistry(ctx.workspaceId)

    return {
      result: undefined,
      audit: {
        entity: 'field_def',
        entityId: fieldId,
        action: 'delete',
        before: { key: found.key, deletedAt: null },
        after: { deletedAt: 'now', purged: false },
      },
    }
  })

export const restoreField = async (ctx: WorkspaceContext, fieldId: string): Promise<void> =>
  mutate(ctx, 'field_def', async (tx) => {
    const [found] = await tx
      .select({ key: fieldDef.key })
      .from(fieldDef)
      .where(eq(fieldDef.id, fieldId))
      .limit(1)
    if (!found) throw new Error('That field does not exist in this workspace.')

    await tx.update(fieldDef).set({ deletedAt: null }).where(eq(fieldDef.id, fieldId))
    forgetRegistry(ctx.workspaceId)

    return {
      result: undefined,
      audit: {
        entity: 'field_def',
        entityId: fieldId,
        action: 'restore',
        before: { deletedAt: 'set' },
        after: { deletedAt: null },
      },
    }
  })

export const listDeletedFields = async (ctx: WorkspaceContext): Promise<AdminField[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: fieldDef.id,
        objectKey: objectDef.key,
        key: fieldDef.key,
        label: fieldDef.label,
        type: fieldDef.type,
        options: fieldDef.options,
        position: fieldDef.position,
      })
      .from(fieldDef)
      .innerJoin(objectDef, eq(objectDef.id, fieldDef.objectId))
      .where(sql`${fieldDef.deletedAt} is not null`)
      .orderBy(asc(objectDef.key), asc(fieldDef.position))

    return rows.map((row) => ({
      id: row.id,
      objectKey: row.objectKey,
      key: row.key,
      label: row.label,
      type: row.type as FieldType,
      storage: 'jsonb' as const,
      isRequired: false,
      isCustom: true,
      isSystem: false,
      isHot: false,
      options: Array.isArray(row.options) ? (row.options as string[]) : [],
      helpText: null,
      position: row.position,
      trackChanges: false,
      indexState: null,
      filledCount: null,
    }))
  })

export type PurgeResult = { stripped: number }

/** Phase two. Strips the key out of every record and removes the definition. This
 *  is the only irreversible half, and it is a separate, explicit action for exactly
 *  that reason. F0 §4. */
export const purgeField = async (ctx: WorkspaceContext, fieldId: string): Promise<PurgeResult> =>
  mutate(ctx, 'field_def', async (tx) => {
    const [found] = await tx
      .select({
        key: fieldDef.key,
        label: fieldDef.label,
        deletedAt: fieldDef.deletedAt,
        storage: fieldDef.storage,
        objectKey: objectDef.key,
      })
      .from(fieldDef)
      .innerJoin(objectDef, eq(objectDef.id, fieldDef.objectId))
      .where(eq(fieldDef.id, fieldId))
      .limit(1)
    if (!found) throw new Error('That field does not exist in this workspace.')
    if (!found.deletedAt) {
      throw new Error(`${found.label} has not been deleted yet. Delete it first, then purge it.`)
    }
    if (found.storage !== 'jsonb') {
      throw new Error(`${found.label} lives in its own column and cannot be purged from here.`)
    }

    assertUsableFieldKey(found.key)
    assertUsableFieldKey(found.objectKey)
    const table = sql.raw(`"${found.objectKey}"`)
    const key = sql.raw(`'${found.key}'`)

    const stripped = await tx.execute<{ id: string }>(
      sql`update ${table} set custom = custom - ${key} where custom ? ${key} returning id`,
    )
    await tx.delete(fieldDef).where(eq(fieldDef.id, fieldId))

    forgetRegistry(ctx.workspaceId)

    return {
      result: { stripped: stripped.length },
      audit: {
        entity: 'field_def',
        entityId: fieldId,
        action: 'purge',
        before: { key: found.key, objectKey: found.objectKey },
        after: { stripped: stripped.length },
      },
    }
  })

export const FIELD_TYPE_CHOICES = FIELD_TYPES.map((type) => ({
  type,
  needsOptions: OPTION_TYPES.has(type),
  editor: TYPE_META[type].editor,
}))
