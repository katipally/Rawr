import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { fieldDef, fieldIndex, objectDef } from '../schema/metadata.ts'
import { conditionalBlocker, conditionalCycle, readConditional, type Conditional } from '../registry/conditional.ts'
import { MAX_CHOICES } from '../registry/mapping.ts'
import { FIELD_TYPES, type FieldType } from '../registry/types.ts'
import { assertCanDo, type AccountContext } from './context.ts'
import { assertUsableFieldKey, unindexableReason } from './fields.ts'
import { mergeTokenPattern } from './sequence-rules.ts'
import { renameChoicesInFormFields, renameChoicesInRules, type ChoiceRenames } from './choice-rules.ts'
import { withAccount, type Tx } from './index.ts'
import { getRegistry, getRegistryIn, mutateRegistry, objectOrThrow, rowsOf, SYSTEM_FIELD_KEYS, tableFor, type RegistryObject } from './registry.ts'
import { searchTextFrom, searchVectorFrom } from './text-match.ts'

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
  /** Why the last build failed, while it is failed. */
  indexError: string | null
  /** Why this property cannot be indexed at all, or null when it can. */
  indexBlocker: string | null
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
        indexError: fieldIndex.lastError,
        objectIsCustom: objectDef.isCustom,
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
      indexError: row.indexState === 'failed' ? row.indexError : null,
      indexBlocker: unindexableReason(row.type as FieldType, row.objectIsCustom),
      filledCount: row.filledCount,
      filledAt: row.filledAt,
      conditional: readConditional(row.conditional),
    }))
  })

const objectRow = async (tx: Tx, objectKey: string): Promise<{ id: string; key: string; nameSingular: string; isCustom: boolean }> => {
  const [found] = await tx
    .select({ id: objectDef.id, key: objectDef.key, nameSingular: objectDef.nameSingular, isCustom: objectDef.isCustom })
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
  if (cleaned.length > MAX_CHOICES) {
    throw new Error(`That is ${cleaned.length} choices; ${MAX_CHOICES} is the limit. A list that long wants to be a relation.`)
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
  ownLabel: string,
  raw: Conditional | null | undefined,
): Promise<Conditional | null> => {
  const rule = readConditional(raw)
  if (!rule) return null
  const siblings = await tx
    .select({ key: fieldDef.key, label: fieldDef.label, conditional: fieldDef.conditional })
    .from(fieldDef)
    .where(and(eq(fieldDef.objectId, objectId), isNull(fieldDef.deletedAt)))
  const blocker = conditionalBlocker(rule, ownKey, new Set(siblings.map((row) => row.key)))
  if (blocker) throw new Error(blocker)
  const loop = conditionalCycle(ownKey, rule, new Map(siblings.map((row) => [row.key, readConditional(row.conditional)])))
  if (loop) {
    const labels = new Map([...siblings.map((row) => [row.key, row.label] as const), [ownKey, ownLabel]])
    throw new Error(
      `${loop.map((key) => `"${labels.get(key) ?? key}"`).join(' -> ')} would hide each other, so none of them could ever appear. Change one of those rules.`,
    )
  }
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
        ? `"${label}" is archived on ${object.nameSingular}, and its data is still stored. Restore it from Archived, or purge it there to free the name.`
        : `${object.nameSingular} already has a property called "${label}".`,
    )
  }

  const conditional = await checkedConditional(tx, object.id, key, label, input.conditional)

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
    indexError: null,
    indexBlocker: unindexableReason(input.type, object.isCustom),
    filledCount: null,
    filledAt: null,
    conditional,
  }
}

/** A new field is always jsonb-stored and always custom. The key is generated once
 *  and never changes, because renaming a label must never touch data. F0 §4. */
export const createField = async (ctx: AccountContext, input: CreateFieldInput): Promise<AdminField> =>
  mutateRegistry(ctx, 'field_def', async (tx) => {
    const result = await insertField(tx, ctx, input)
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
  mutateRegistry(ctx, 'field_def', async (tx) => {
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

/** A choice renamed in place. Stored values and the rules that name a choice hold its
 *  text, so the rename is the only way to carry them across; a bare list cannot say
 *  which choice became which. */
export type OptionRename = { from: string; to: string }

export type UpdateFieldInput = {
  id: string
  label?: string
  options?: string[]
  renames?: OptionRename[]
  helpText?: string | null
  isRequired?: boolean
  trackChanges?: boolean
  groupName?: string | null
  /** Undefined leaves the rule alone; null clears it. */
  conditional?: Conditional | null
}

/** The choices a stored value is checked against, after a rename or a removal. A
 *  rename moves every record that holds the old text, and the rules that name it; a
 *  removal is refused while any record (trashed ones too: a restore would bring the
 *  value back) still holds one. */
const rewriteChoices = async (
  tx: Tx,
  field: { objectId: string; key: string; label: string; type: string; storage: string; columnName: string | null; options: unknown },
  options: string[],
  input: OptionRename[],
): Promise<void> => {
  const current = field.options as string[]
  const renames = input.map((rename) => ({ from: rename.from.trim(), to: rename.to.trim() })).filter((rename) => rename.from !== rename.to)
  const renamedFrom = new Set(renames.map((rename) => rename.from))
  if (renamedFrom.size !== renames.length) throw new Error(`A choice cannot be renamed twice in one save.`)
  for (const rename of renames) {
    if (!current.includes(rename.from)) throw new Error(`${rename.from} is not a choice on ${field.label}.`)
    if (!options.includes(rename.to)) throw new Error(`${rename.to} is renamed to, but it is not in the list of choices.`)
    if (current.includes(rename.to) && !renamedFrom.has(rename.to)) {
      throw new Error(`${rename.to} is already a choice on ${field.label}.`)
    }
  }

  const removed = current.filter((choice) => !options.includes(choice) && !renamedFrom.has(choice))
  const object = (await getRegistryIn(tx)).objects.find((candidate) => candidate.id === field.objectId)
  if (!object) throw new Error(`The object for ${field.label} does not exist.`)
  const column = field.storage === 'column' && field.columnName ? sql.raw(`"${field.columnName}"`) : null
  const multi = field.type === 'multi_select'

  if (removed.length > 0) {
    const holds = column
      ? sql`${column} in (${sql.join(removed.map((choice) => sql`${choice}`), sql`, `)})`
      : multi
        ? sql`custom -> ${field.key}::text ?| array[${sql.join(removed.map((choice) => sql`${choice}`), sql`, `)}]::text[]`
        : sql`custom ->> ${field.key}::text in (${sql.join(removed.map((choice) => sql`${choice}`), sql`, `)})`
    const [row] = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from ${tableFor(object)} where ${rowsOf(object)} and ${holds}`,
    )
    const n = Number(row?.n ?? 0)
    if (n > 0) {
      const names = removed.join(', ')
      throw new Error(`${n} ${n === 1 ? 'record still uses' : 'records still use'} ${names}. Change them first.`)
    }
  }

  if (renames.length === 0) return
  const mapping = sql`${JSON.stringify(Object.fromEntries(renames.map((rename) => [rename.from, rename.to])))}::jsonb`
  const froms = sql.join(renames.map((rename) => sql`${rename.from}`), sql`, `)
  if (column) {
    await tx.execute(sql`update ${tableFor(object)} set ${column} = (${mapping} ->> ${sql.raw(`"${field.columnName}"`)})
      where ${rowsOf(object)} and ${column} in (${froms})`)
  } else if (multi) {
    await tx.execute(sql`update ${tableFor(object)} set custom = jsonb_set(custom, array[${field.key}::text], (
        select coalesce(jsonb_agg(coalesce(${mapping} ->> v.value, v.value) order by v.ord), '[]'::jsonb)
          from jsonb_array_elements_text(custom -> ${field.key}::text) with ordinality as v(value, ord)))
      where ${rowsOf(object)} and jsonb_typeof(custom -> ${field.key}::text) = 'array'
        and custom -> ${field.key}::text ?| array[${froms}]::text[]`)
  } else {
    await tx.execute(sql`update ${tableFor(object)} set custom = jsonb_set(custom, array[${field.key}::text], to_jsonb(${mapping} ->> (custom ->> ${field.key}::text)))
      where ${rowsOf(object)} and custom ->> ${field.key}::text in (${froms})`)
  }
  await rewriteRulesNaming(tx, { objectId: object.id, objectKey: object.key, fieldKey: field.key }, renames)
  if (object.isCustom) await rewriteSearchOf(tx, object.key)
}

/** The rules that name a choice of one property by its text, rewritten in the rename's
 *  transaction. Each table is read only where its JSON mentions the key, and a row is
 *  written only when its rule changed. One pass per table, so the cost is the size of
 *  the rules that mention the key, not the number of choices renamed. */
const rewriteRulesNaming = async (
  tx: Tx,
  object: { objectId: string; objectKey: string; fieldKey: string },
  renames: OptionRename[],
): Promise<void> => {
  const map: ChoiceRenames = new Map(renames.map((rename) => [rename.from, rename.to]))
  const quoted = `%"${object.fieldKey}"%`
  const target = `%"${object.objectKey}.${object.fieldKey}"%`
  const changed = (before: unknown, after: unknown) => JSON.stringify(before) !== JSON.stringify(after)

  const views = await tx.execute<{ id: string; filters: unknown }>(sql`
    select id, filters from saved_view where object_id = ${object.objectId}::uuid and filters::text like ${quoted}`)
  for (const row of views) {
    const filters = renameChoicesInRules(row.filters, object.fieldKey, map)
    if (changed(row.filters, filters)) {
      await tx.execute(sql`update saved_view set filters = ${JSON.stringify(filters)}::jsonb, updated_at = now() where id = ${row.id}::uuid`)
    }
  }

  const segments = await tx.execute<{ id: string; query: unknown }>(sql`
    select id, query from segment where object_id = ${object.objectId}::uuid and query::text like ${quoted}`)
  for (const row of segments) {
    const query = renameChoicesInRules(row.query, object.fieldKey, map)
    if (changed(row.query, query)) {
      await tx.execute(sql`update segment set query = ${JSON.stringify(query)}::jsonb where id = ${row.id}::uuid`)
    }
  }

  const automations = await tx.execute<{ id: string; conditions: unknown; steps: unknown }>(sql`
    select id, conditions, steps from automation
     where trigger_config ->> 'object' = ${object.objectKey}
       and (conditions::text like ${quoted} or steps::text like ${quoted})`)
  for (const row of automations) {
    const conditions = renameChoicesInRules(row.conditions, object.fieldKey, map)
    const steps = renameChoicesInRules(row.steps, object.fieldKey, map)
    if (changed(row.conditions, conditions) || changed(row.steps, steps)) {
      await tx.execute(sql`update automation set conditions = ${JSON.stringify(conditions)}::jsonb, steps = ${JSON.stringify(steps)}::jsonb, updated_at = now() where id = ${row.id}::uuid`)
    }
  }

  const properties = await tx.execute<{ id: string; conditional: unknown }>(sql`
    select id, conditional from field_def
     where object_id = ${object.objectId}::uuid and deleted_at is null and conditional::text like ${quoted}`)
  for (const row of properties) {
    const conditional = renameChoicesInRules(row.conditional, object.fieldKey, map)
    if (changed(row.conditional, conditional)) {
      await tx.execute(sql`update field_def set conditional = ${JSON.stringify(conditional)}::jsonb where id = ${row.id}::uuid`)
    }
  }

  const forms = await tx.execute<{ id: string; schema: unknown }>(sql`
    select id, schema from form where schema::text like ${target}`)
  for (const row of forms) {
    if (!Array.isArray(row.schema)) continue
    const schema = renameChoicesInFormFields(row.schema, `${object.objectKey}.${object.fieldKey}`, map)
    if (changed(row.schema, schema)) {
      await tx.execute(sql`update form set schema = ${JSON.stringify(schema)}::jsonb, updated_at = now() where id = ${row.id}::uuid`)
    }
  }
}

/** Label, help text, choices and the two flags. The key and the type are not here
 *  on purpose: both would change what stored values mean, and a field whose meaning
 *  changed under the data is worse than a second field. */
export const updateField = async (ctx: AccountContext, input: UpdateFieldInput): Promise<void> =>
  mutateRegistry(ctx, 'field_def', async (tx) => {
    const [before] = await tx
      .select({
        objectId: fieldDef.objectId,
        key: fieldDef.key,
        label: fieldDef.label,
        type: fieldDef.type,
        storage: fieldDef.storage,
        columnName: fieldDef.columnName,
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
        : await checkedConditional(tx, before.objectId, before.key, label || before.label, input.conditional)

    const options = input.options ? validateOptions(before.type as FieldType, input.options) : undefined
    if (options) await rewriteChoices(tx, before, options, input.renames ?? [])

    await tx
      .update(fieldDef)
      .set({
        ...(label ? { label } : {}),
        ...(options ? { options } : {}),
        ...(input.helpText !== undefined ? { helpText: input.helpText?.trim() || null } : {}),
        ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
        ...(input.trackChanges !== undefined ? { trackChanges: input.trackChanges } : {}),
        ...(input.groupName !== undefined ? { groupName: input.groupName?.trim() || null } : {}),
        ...(conditional !== undefined ? { conditional } : {}),
      })
      .where(eq(fieldDef.id, input.id))

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
  mutateRegistry(ctx, 'field_def', async (tx) => {
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
export type FieldUse = {
  kind: 'form' | 'segment' | 'view' | 'automation' | 'property' | 'sequence' | 'template' | 'booking'
  name: string
}

export type FieldUsage = {
  filled: number
  label: string
  key: string
  objectKey: string
  usedIn: FieldUse[]
  /** Every use, where `usedIn` holds the first fifty by kind and name. */
  usedInTotal: number
}

/** Every place that reads a property by its key. The "Used in" list and the delete
 *  refusal are both built from this, so the warning and the dialog cannot disagree. */
const usesOf = async (
  tx: Tx,
  field: { id: string; key: string; objectKey: string },
): Promise<{ usedIn: FieldUse[]; total: number }> => {
  const { key, objectKey } = field
  // Forms store "contact.email" and everything else the bare key. A quoted key in
  // serialised jsonb cannot match part of a longer one, because the key alphabet is
  // [a-z0-9_] and the closing quote ends it.
  const quoted = `%"${key}"%`
  const mapped = `%"${objectKey}.${key}"%`
  // Merge tokens are prose, so they match as whole `{{key}}` tokens. Sequences and
  // templates are sent to contacts, so a plain key only names a contact property.
  const token = mergeTokenPattern(key)
  const dotted = mergeTokenPattern(`${objectKey}.${key}`)
  const contactOnly = objectKey === 'contact'
  const rows = await tx.execute<FieldUse & { total: number }>(sql`
    select kind, name, count(*) over () as total from (
        select 'form' as kind, name from form where schema::text like ${mapped}
        union all
        select 'segment', s.name from segment s join object_def o on o.id = s.object_id
         where o.key = ${objectKey} and s.query::text like ${quoted}
        union all
        select 'view', v.name from saved_view v join object_def o on o.id = v.object_id
         where o.key = ${objectKey}
           and (v.filters::text like ${quoted} or v.sorts::text like ${quoted} or v.columns::text like ${quoted})
        union all
        select 'automation', name from automation
         where trigger_config->>'object' = ${objectKey}
           and (conditions::text like ${quoted} or steps::text like ${quoted})
        union all
        select 'property', f.label from field_def f join object_def o on o.id = f.object_id
         where o.key = ${objectKey} and f.id <> ${field.id}::uuid and f.deleted_at is null
           and f.conditional->'conditions' @> jsonb_build_array(jsonb_build_object('field', ${key}::text))
        union all
        select 'sequence', s.name from sequence_step st join sequence s on s.id = st.sequence_id
         where ${contactOnly} and (st.subject ~* ${token} or st.subject_b ~* ${token}
            or st.body_html ~* ${token} or st.body_text ~* ${token}
            or st.task_title ~* ${token} or st.task_body ~* ${token})
        union all
        select 'template', t.name from email_template t
         where ${contactOnly} and (t.subject ~* ${token} or t.body_text ~* ${token})
        union all
        select 'booking', b.name from booking_page b
         where b.title_tpl ~* ${dotted} or b.description_tpl ~* ${dotted}
            or (${contactOnly} and b.questions @> jsonb_build_array(jsonb_build_object('key', ${key}::text)))
      ) uses
     order by kind, name
     limit 50`)

  return { usedIn: rows.map(({ kind, name }) => ({ kind, name })), total: Number(rows[0]?.total ?? 0) }
}

/** What archiving a property that something reads says, and what the server refuses
 *  with until the archive is confirmed. */
export const dependantsWarning = (label: string, total: number): string =>
  `${label} is used in ${total} ${total === 1 ? 'place' : 'places'}. Archiving it leaves ${total === 1 ? 'that place' : 'those places'} pointing at nothing, so confirm the archive to go ahead.`

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
    const object = objectOrThrow(await getRegistryIn(tx), found.objectKey)
    const predicate =
      found.storage === 'column' && found.columnName
        ? sql.raw(`"${found.columnName}" is not null`)
        : sql.raw(`custom ? '${found.key}' and custom ->> '${found.key}' is not null`)

    const [row] = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from ${tableFor(object)} where ${rowsOf(object)} and deleted_at is null and ${predicate}`,
    )
    const uses = await usesOf(tx, { id: fieldId, key: found.key, objectKey: found.objectKey })

    return {
      filled: Number(row?.n ?? 0),
      key: found.key,
      label: found.label,
      objectKey: found.objectKey,
      usedIn: uses.usedIn,
      usedInTotal: uses.total,
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
  mutateRegistry(ctx, 'field_def', async (tx) => {
    const object = await objectRow(tx, objectKey)
    const name = to.trim()
    if (!name) throw new Error('A group needs a name.')
    const moved = await tx
      .update(fieldDef)
      .set({ groupName: name })
      .where(and(eq(fieldDef.objectId, object.id), eq(fieldDef.groupName, from)))
      .returning({ id: fieldDef.id })

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
  mutateRegistry(ctx, 'field_def', async (tx) => {
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

/** The search columns of a custom object's rows, rebuilt from the row's own blob so they
 *  keep only the text of fields the object still has. A core table generates its search
 *  column and has no search_text, so it gets nothing here. */
const searchColumnsOf = (object: RegistryObject): SQL[] => {
  if (!object.isCustom) return []
  const custom = sql.raw(`"${object.key}"."custom"`)
  return [sql`"search" = ${searchVectorFrom(object, custom)}`, sql`"search_text" = ${searchTextFrom(object, custom)}`]
}

/** A field's text is searchable only while the field is live, so every record of the
 *  object is rewritten when one is archived or restored. One statement, no row loop. */
const rewriteSearchOf = async (tx: Tx, objectKey: string): Promise<void> => {
  const object = objectOrThrow(await getRegistryIn(tx), objectKey)
  const columns = searchColumnsOf(object)
  if (columns.length === 0) return
  await tx.execute(sql`update ${tableFor(object)} set ${sql.join(columns, sql`, `)} where ${rowsOf(object)}`)
}

/** Phase one of two. The field disappears from every surface immediately and the
 *  data stays exactly where it was, so a misclick costs nothing. F0 §4. */
export const deleteField = async (
  ctx: AccountContext,
  fieldId: string,
  options: { acknowledgeUses?: boolean } = {},
): Promise<void> =>
  mutateRegistry(ctx, 'field_def', async (tx) => {
    const [found] = await tx
      .select({
        key: fieldDef.key,
        label: fieldDef.label,
        isCustom: fieldDef.isCustom,
        storage: fieldDef.storage,
        objectKey: objectDef.key,
      })
      .from(fieldDef)
      .innerJoin(objectDef, eq(objectDef.id, fieldDef.objectId))
      .where(and(eq(fieldDef.id, fieldId), isNull(fieldDef.deletedAt)))
      .limit(1)
    if (!found) throw new Error('That field does not exist, or it has already been deleted.')
    if (!found.isCustom || found.storage !== 'jsonb') {
      throw new Error(
        `${found.label} is a core field. Core fields have their own column and their own meaning across the product, so they cannot be deleted.`,
      )
    }
    const uses = await usesOf(tx, { id: fieldId, key: found.key, objectKey: found.objectKey })
    if (uses.total > 0 && !options.acknowledgeUses) throw new Error(dependantsWarning(found.label, uses.total))

    await tx.update(fieldDef).set({ deletedAt: new Date() }).where(eq(fieldDef.id, fieldId))
    // A hot index on a field nobody can see is dead weight, and the field may be
    // restored, so the record goes and the index is rebuilt if it comes back.
    await tx.update(fieldDef).set({ isHot: false }).where(eq(fieldDef.id, fieldId))
    await tx.delete(fieldIndex).where(eq(fieldIndex.fieldId, fieldId))
    await rewriteSearchOf(tx, found.objectKey)

    return {
      result: undefined,
      audit: {
        entity: 'field_def',
        entityId: fieldId,
        action: 'delete',
        before: { key: found.key, deletedAt: null },
        after: { deletedAt: 'now', purged: false, uses: uses.total },
      },
    }
  })

export const restoreField = async (ctx: AccountContext, fieldId: string): Promise<void> =>
  mutateRegistry(ctx, 'field_def', async (tx) => {
    const [found] = await tx
      .select({ objectKey: objectDef.key })
      .from(fieldDef)
      .innerJoin(objectDef, eq(objectDef.id, fieldDef.objectId))
      .where(eq(fieldDef.id, fieldId))
      .limit(1)
    if (!found) throw new Error('That field does not exist in this account.')

    await tx.update(fieldDef).set({ deletedAt: null }).where(eq(fieldDef.id, fieldId))
    await rewriteSearchOf(tx, found.objectKey)
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
      indexError: null,
      indexBlocker: null,
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
  return mutateRegistry(ctx, 'field_def', async (tx) => {
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
    const object = objectOrThrow(await getRegistryIn(tx), found.objectKey)
    const key = sql.raw(`'${found.key}'`)

    const stripped = await tx.execute<{ id: string }>(
      sql`update ${tableFor(object)} set ${sql.join([sql`custom = custom - ${key}`, ...searchColumnsOf(object)], sql`, `)} where ${rowsOf(object)} and custom ? ${key} returning id`,
    )
    await tx.delete(fieldDef).where(eq(fieldDef.id, fieldId))

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
