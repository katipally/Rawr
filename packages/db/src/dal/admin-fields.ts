import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { fieldDef, fieldIndex, objectDef } from '../schema/metadata.ts'
import { conditionalBlocker, readConditional, type Conditional } from '../registry/conditional.ts'
import { FIELD_TYPES, type FieldType } from '../registry/types.ts'
import { assertCanDo, type AccountContext } from './context.ts'
import { assertUsableFieldKey } from './fields.ts'
import { mutate, withAccount, type Tx } from './index.ts'
import { forgetRegistry, getRegistry, rowsOf, SYSTEM_FIELD_KEYS, tableFor } from './registry.ts'

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
  /** What this sits under on the settings screen. Null is ungrouped. */
  groupName: string | null
  /** Which import wrote the definition, or null for one added by hand. */
  source: string | null
  /** Set once a hot index has been asked for, so the UI can show its state. */
  indexState: string | null
  /** How many records currently hold a value, so a delete can say what is at stake. */
  filledCount: number | null
  /** When that count was taken. A number with no date behind it reads as live,
   *  and this one is a night old. */
  filledAt: Date | null
  /** While this does not match the record's other values, the property is not on
   *  the record. Null is a property that is always there. */
  conditional: Conditional | null
}

const OPTION_TYPES = new Set<FieldType>(['select', 'multi_select'])

export const listFields = async (ctx: AccountContext, objectKey?: string): Promise<AdminField[]> =>
  withAccount(ctx, async (tx) => {
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
        groupName: fieldDef.groupName,
        source: fieldDef.source,
        conditional: fieldDef.conditional,
        filledCount: fieldDef.filledCount,
        filledAt: fieldDef.filledAt,
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
      groupName: row.groupName,
      source: row.source,
      isSystem: SYSTEM_FIELD_KEYS.has(row.key),
      isHot: row.isHot,
      options: Array.isArray(row.options) ? (row.options as string[]) : [],
      helpText: row.helpText,
      position: row.position,
      trackChanges: row.trackChanges,
      indexState: row.indexState ?? null,
      filledCount: row.filledCount,
      filledAt: row.filledAt,
      conditional: readConditional(row.conditional),
    }))
  })

const objectRow = async (tx: Tx, objectKey: string): Promise<{ id: string; key: string }> => {
  const [found] = await tx
    .select({ id: objectDef.id, key: objectDef.key })
    .from(objectDef)
    .where(eq(objectDef.key, objectKey))
    .limit(1)
  if (!found) throw new Error(`This account has no object called "${objectKey}".`)
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
  /** What this sits under on the settings screen. Null is ungrouped. */
  groupName?: string | null
  /** Which import wrote it, or null for a field somebody added here. */
  source?: string | null
  /** Conditional property logic. The property is off the record until it matches. */
  conditional?: Conditional | null
}

/** A rule over fields that exist, and never over the field it governs. Checked
 *  here rather than at the editor, because an import and the agent tools reach
 *  the same write path. */
const checkedConditional = async (
  tx: Tx,
  objectId: string,
  ownKey: string,
  raw: Conditional | null | undefined,
): Promise<Conditional | null> => {
  const rule = readConditional(raw)
  if (!rule) return null
  const keys = await tx
    .select({ key: fieldDef.key })
    .from(fieldDef)
    .where(and(eq(fieldDef.objectId, objectId), isNull(fieldDef.deletedAt)))
  const blocker = conditionalBlocker(rule, ownKey, new Set(keys.map((row) => row.key)))
  if (blocker) throw new Error(blocker)
  return rule
}

/** The insert itself, shared by the one-at-a-time create and the bulk one an
 *  import runs. Both have to validate identically: a property that arrives from a
 *  file is the same property as one somebody typed. */
const insertField = async (
  tx: Tx,
  ctx: AccountContext,
  input: CreateFieldInput,
): Promise<AdminField> => {
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

  const conditional = await checkedConditional(tx, object.id, key, input.conditional)

  const [{ next = 0 } = { next: 0 }] = await tx.execute<{ next: number }>(
    sql`select coalesce(max(position), -1) + 1 as next from field_def where object_id = ${object.id}`,
  )

  const options = validateOptions(input.type, input.options ?? [])
  const [created] = await tx
    .insert(fieldDef)
    .values({
      accountId: ctx.accountId,
      objectId: object.id,
      key,
      label,
      type: input.type,
      storage: 'jsonb',
      columnName: null,
      isCustom: true,
      isRequired: input.isRequired ?? false,
      trackChanges: input.trackChanges ?? false,
      options,
      helpText: input.helpText?.trim() || null,
      groupName: input.groupName?.trim() || null,
      source: input.source ?? null,
      conditional,
      position: Number(next),
    })
    .returning({ id: fieldDef.id })
  if (!created) throw new Error('The field could not be created.')

  return {
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
    options,
    helpText: input.helpText?.trim() || null,
    position: Number(next),
    trackChanges: input.trackChanges ?? false,
    groupName: input.groupName?.trim() || null,
    source: input.source ?? null,
    indexState: null,
    filledCount: null,
    filledAt: null,
    conditional,
  }
}

/** A new field is always jsonb-stored and always custom. The key is generated once
 *  and never changes, because renaming a label must never touch data. F0 §4. */
export const createField = async (ctx: AccountContext, input: CreateFieldInput): Promise<AdminField> =>
  mutate(ctx, 'field_def', async (tx) => {
    const result = await insertField(tx, ctx, input)
    forgetRegistry(ctx.accountId)
    return {
      result,
      audit: {
        entity: 'field_def',
        entityId: result.id,
        action: 'create',
        before: null,
        after: { objectKey: result.objectKey, key: result.key, label: result.label, type: input.type },
      },
    }
  })

/** Every property a file needs, in one transaction. An import that creates
 *  sixty-eight of them one at a time can stop after forty and leave a mapping
 *  pointing at fields half of which exist; this either creates all of them or
 *  none. A key that is already taken is left alone and reported, because the
 *  caller maps to it rather than making a second one. */
export const createFields = async (
  ctx: AccountContext,
  inputs: CreateFieldInput[],
): Promise<{ created: AdminField[]; alreadyThere: string[] }> =>
  mutate(ctx, 'field_def', async (tx) => {
    const created: AdminField[] = []
    const alreadyThere: string[] = []
    for (const input of inputs) {
      const object = await objectRow(tx, input.objectKey)
      const key = input.key.trim().toLowerCase()
      const [taken] = await tx
        .select({ id: fieldDef.id })
        .from(fieldDef)
        .where(and(eq(fieldDef.objectId, object.id), eq(fieldDef.key, key), isNull(fieldDef.deletedAt)))
        .limit(1)
      if (taken) {
        alreadyThere.push(key)
        continue
      }
      created.push(await insertField(tx, ctx, input))
    }

    forgetRegistry(ctx.accountId)

    return {
      result: { created, alreadyThere },
      audit: {
        entity: 'field_def',
        entityId: created[0]?.id ?? null,
        action: 'create',
        before: null,
        after: {
          objectKey: inputs[0]?.objectKey ?? null,
          groupName: inputs[0]?.groupName ?? null,
          created: created.map((field) => field.key),
          alreadyThere,
        },
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
  groupName?: string | null
  /** Undefined leaves the rule alone; null clears it. */
  conditional?: Conditional | null
}

/** Label, help text, choices and the two flags. The key and the type are not here
 *  on purpose: both would change what stored values mean, and a field whose meaning
 *  changed under the data is worse than a second field. */
export const updateField = async (ctx: AccountContext, input: UpdateFieldInput): Promise<void> =>
  mutate(ctx, 'field_def', async (tx) => {
    const [before] = await tx
      .select({
        objectId: fieldDef.objectId,
        key: fieldDef.key,
        label: fieldDef.label,
        type: fieldDef.type,
        options: fieldDef.options,
        helpText: fieldDef.helpText,
        isRequired: fieldDef.isRequired,
        trackChanges: fieldDef.trackChanges,
        groupName: fieldDef.groupName,
        conditional: fieldDef.conditional,
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

    const conditional =
      input.conditional === undefined
        ? undefined
        : await checkedConditional(tx, before.objectId, before.key, input.conditional)

    await tx
      .update(fieldDef)
      .set({
        ...(label ? { label } : {}),
        ...(input.options ? { options: validateOptions(before.type as FieldType, input.options) } : {}),
        ...(input.helpText !== undefined ? { helpText: input.helpText?.trim() || null } : {}),
        ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
        ...(input.trackChanges !== undefined ? { trackChanges: input.trackChanges } : {}),
        ...(input.groupName !== undefined ? { groupName: input.groupName?.trim() || null } : {}),
        ...(conditional !== undefined ? { conditional } : {}),
      })
      .where(eq(fieldDef.id, input.id))

    forgetRegistry(ctx.accountId)

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
 *  long-lived account never accumulates gaps. */
export const reorderFields = async (
  ctx: AccountContext,
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

    forgetRegistry(ctx.accountId)

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

/** Where a property is spoken for. HubSpot calls this "Used in", and it is the
 *  difference between deleting a property and breaking a form nobody remembered. */
export type FieldUse = { kind: 'form' | 'segment' | 'view' | 'automation'; name: string }

export type FieldUsage = {
  filled: number
  label: string
  key: string
  objectKey: string
  usedIn: FieldUse[]
}

/** How many records hold a value and what refers to it, so a delete confirmation
 *  can say what is at stake rather than asking somebody to guess. */
export const fieldUsage = async (ctx: AccountContext, fieldId: string): Promise<FieldUsage> =>
  withAccount(ctx, async (tx) => {
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
    if (!found) throw new Error('That field does not exist in this account.')

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

    // A form stores the field as "contact.email" and everything else as the bare
    // key. Both are matched against the serialised jsonb: the key alphabet is
    // [a-z0-9_], so a quoted key cannot match half of a longer one, and these
    // four tables hold tens of rows rather than tens of thousands.
    const quoted = `%"${found.key}"%`
    const mapped = `%"${found.objectKey}.${found.key}"%`
    const usedIn = await tx.execute<{ kind: FieldUse['kind']; name: string }>(sql`
        select 'form' as kind, name from form where schema::text like ${mapped}
        union all
        select 'segment', s.name from segment s join object_def o on o.id = s.object_id
         where o.key = ${found.objectKey} and s.query::text like ${quoted}
        union all
        select 'view', v.name from saved_view v join object_def o on o.id = v.object_id
         where o.key = ${found.objectKey}
           and (v.filters::text like ${quoted} or v.sorts::text like ${quoted} or v.columns::text like ${quoted})
        union all
        select 'automation', name from automation
         where conditions::text like ${quoted} or steps::text like ${quoted}
        limit 50`)

    return {
      filled: Number(row?.n ?? 0),
      key: found.key,
      label: found.label,
      objectKey: found.objectKey,
      usedIn: usedIn.map((use) => ({ kind: use.kind, name: use.name })),
    }
  })

/** Renaming a group is renaming it on every property that names one, because the
 *  group is the name and nothing else holds it. HubSpot's Groups tab does the
 *  same thing from the other end. */
export const renameFieldGroup = async (
  ctx: AccountContext,
  objectKey: string,
  from: string,
  to: string,
): Promise<{ moved: number }> =>
  mutate(ctx, 'field_def', async (tx) => {
    const object = await objectRow(tx, objectKey)
    const name = to.trim()
    if (!name) throw new Error('A group needs a name.')
    const moved = await tx
      .update(fieldDef)
      .set({ groupName: name })
      .where(and(eq(fieldDef.objectId, object.id), eq(fieldDef.groupName, from)))
      .returning({ id: fieldDef.id })

    forgetRegistry(ctx.accountId)

    return {
      result: { moved: moved.length },
      audit: {
        entity: 'field_def',
        entityId: object.id,
        action: 'update',
        before: { groupName: from },
        after: { groupName: name, moved: moved.length },
      },
    }
  })

/** Properties into a group, which is also how one is made: a group exists once
 *  something is in it. Null empties them out of every group. */
export const moveFieldsToGroup = async (
  ctx: AccountContext,
  objectKey: string,
  fieldIds: string[],
  groupName: string | null,
): Promise<{ moved: number }> =>
  mutate(ctx, 'field_def', async (tx) => {
    const object = await objectRow(tx, objectKey)
    if (fieldIds.length === 0) throw new Error('Pick at least one property to move.')
    const name = groupName?.trim() || null
    const moved = await tx
      .update(fieldDef)
      .set({ groupName: name })
      .where(and(eq(fieldDef.objectId, object.id), inArray(fieldDef.id, fieldIds)))
      .returning({ id: fieldDef.id })
    if (moved.length !== fieldIds.length) {
      throw new Error(`${fieldIds.length - moved.length} of those properties are not on ${object.key}.`)
    }

    forgetRegistry(ctx.accountId)

    return {
      result: { moved: moved.length },
      audit: {
        entity: 'field_def',
        entityId: object.id,
        action: 'update',
        before: null,
        after: { groupName: name, fieldIds },
      },
    }
  })

/** The fill rate for every property in the account, recomputed.
 *
 *  One statement per object rather than one per property: the answer for all
 *  three hundred and seventy-two contact properties is three hundred and
 *  seventy-two filtered aggregates over a single scan of `contact`, and the
 *  alternative is three hundred and seventy-two scans. Run nightly, which is why
 *  the count carries the time it was taken. */
export const refreshFillRates = async (
  ctx: AccountContext,
): Promise<{ objects: number; fields: number }> => {
  const registry = await getRegistry(ctx)
  let counted = 0
  for (const object of registry.objects) {
    const fields = object.fields.filter((field) => !field.isSystem)
    if (fields.length === 0) continue

    const aggregates = fields.map((field, index) => {
      assertUsableFieldKey(field.key)
      const alias = sql.raw(`f${index}`)
      if (field.storage === 'column' && field.columnName) {
        assertUsableFieldKey(field.columnName)
        return sql`count(*) filter (where ${sql.raw(`"${object.key}"."${field.columnName}"`)} is not null) as ${alias}`
      }
      const path = sql.raw(`"${object.key}"."custom" ->> '${field.key}'`)
      return sql`count(*) filter (where ${path} is not null and ${path} <> '') as ${alias}`
    })

    const [row] = await withAccount(ctx, (tx) =>
      tx.execute<Record<string, number>>(sql`
        select ${sql.join(aggregates, sql`, `)}
          from ${tableFor(object)}
         where ${rowsOf(object)} and ${sql.raw(`"${object.key}"."deleted_at"`)} is null`),
    )
    if (!row) continue

    const pairs = fields.map((field, index) => sql`(${field.id}::uuid, ${Number(row[`f${index}`] ?? 0)}::int)`)
    await withAccount(ctx, (tx) =>
      tx.execute(sql`
        update field_def f set filled_count = v.n, filled_at = now()
          from (values ${sql.join(pairs, sql`, `)}) as v(id, n)
         where f.id = v.id`),
    )
    counted += fields.length
  }
  return { objects: registry.objects.length, fields: counted }
}

/** Phase one of two. The field disappears from every surface immediately and the
 *  data stays exactly where it was, so a misclick costs nothing. F0 §4. */
export const deleteField = async (ctx: AccountContext, fieldId: string): Promise<void> =>
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

    forgetRegistry(ctx.accountId)

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

export const restoreField = async (ctx: AccountContext, fieldId: string): Promise<void> =>
  mutate(ctx, 'field_def', async (tx) => {
    const [found] = await tx
      .select({ key: fieldDef.key })
      .from(fieldDef)
      .where(eq(fieldDef.id, fieldId))
      .limit(1)
    if (!found) throw new Error('That field does not exist in this account.')

    await tx.update(fieldDef).set({ deletedAt: null }).where(eq(fieldDef.id, fieldId))
    forgetRegistry(ctx.accountId)

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

export const listDeletedFields = async (ctx: AccountContext): Promise<AdminField[]> =>
  withAccount(ctx, async (tx) => {
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
      groupName: null,
      source: null,
      indexState: null,
      filledCount: null,
      filledAt: null,
      conditional: null,
    }))
  })

export type PurgeResult = { stripped: number }

/** Phase two. Strips the key out of every record and removes the definition. This
 *  is the only irreversible half, and it is a separate, explicit action for exactly
 *  that reason. F0 §4. */
export const purgeField = async (ctx: AccountContext, fieldId: string): Promise<PurgeResult> => {
  assertCanDo(ctx, 'purge')
  return mutate(ctx, 'field_def', async (tx) => {
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
    if (!found) throw new Error('That field does not exist in this account.')
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

    forgetRegistry(ctx.accountId)

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
}
