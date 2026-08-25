import { sql, type SQL } from 'drizzle-orm'
import type { ObjectKey } from '../registry/core.ts'
import { moveActivityLinks, recordActivity, type EntityType } from './activity.ts'
import { moveVisitorHistory } from './stitch.ts'
import type { WorkspaceContext } from './context.ts'
import { assertCanWrite } from './context.ts'
import { companyNameFromDomain, employerDomainFromEmail } from './domains.ts'
import { mutate, withWorkspace, writeAudit, type Tx } from './index.ts'
import {
  compileFilters,
  fieldExpression,
  orderPlan,
  scopeFor,
  type Cursor,
  type FilterGroup,
  type QueryScope,
  type Sort,
} from './query.ts'
import { fieldOrThrow, getRegistryIn, objectOrThrow, type Registry, type RegistryField, type RegistryObject } from './registry.ts'
import { coerce, ValueError } from './values.ts'

export type RecordValues = Record<string, unknown>

/** A relation field points at exactly one table, and its label comes from exactly
 *  one column. Kept here rather than in the registry because these five are core
 *  fields on core objects; a custom relation would need a target on field_def. */
const RELATION_TARGETS: Record<string, { table: string; label: string }> = {
  owner_id: { table: 'user_account', label: 'name' },
  // Many companies in the real portal have a blank name, so the domain stands in
  // rather than leaving a row labelled with nothing.
  company_id: { table: 'company', label: `coalesce("name", "domain")` },
  stage_id: { table: 'pipeline_stage', label: 'name' },
  pipeline_id: { table: 'pipeline', label: 'name' },
  lifecycle_stage_id: { table: 'lifecycle_stage', label: 'name' },
}

export class ConflictError extends Error {
  readonly currentUpdatedAt: Date
  constructor(currentUpdatedAt: Date) {
    super('Someone else changed this record while you were editing it. Reload to see their change, then re-apply yours.')
    this.name = 'ConflictError'
    this.currentUpdatedAt = currentUpdatedAt
  }
}

export class DuplicateError extends Error {
  readonly existingId: string
  readonly what: string
  constructor(what: string, existingId: string) {
    super(`${what} already belongs to another record. Merge them instead of creating a second one.`)
    this.name = 'DuplicateError'
    this.existingId = existingId
    this.what = what
  }
}

/** What a record is called on screen, in a link, and in a timeline sentence. */
export const displayName = (objectKey: ObjectKey, values: RecordValues): string => {
  if (objectKey === 'contact') {
    const full = [values.first_name, values.last_name].filter(Boolean).join(' ').trim()
    return full || String(values.email ?? '') || 'Unnamed contact'
  }
  if (objectKey === 'company') {
    return String(values.name ?? '') || String(values.domain ?? '') || 'Unnamed company'
  }
  return String(values.name ?? '') || 'Unnamed deal'
}

const selectExpression = (object: RegistryObject, field: RegistryField): SQL =>
  sql`${fieldExpression(object, field)} as ${sql.raw(`"${field.key}"`)}`

const NOT_DELETED = (object: RegistryObject): SQL =>
  sql.raw(`"${object.key}"."deleted_at" is null`)

/** Resolves relation and user ids to the names a person reads, one query per
 *  referenced table for the whole page rather than one per row. */
const resolveLabels = async (
  tx: Tx,
  fields: RegistryField[],
  rows: RecordValues[],
): Promise<Map<string, string>> => {
  const wanted = new Map<string, Set<string>>()
  for (const field of fields) {
    const target = RELATION_TARGETS[field.key]
    if (!target) continue
    for (const row of rows) {
      const id = row[field.key]
      if (typeof id !== 'string') continue
      const bucket = wanted.get(target.table) ?? new Set<string>()
      bucket.add(id)
      wanted.set(target.table, bucket)
    }
  }

  const labels = new Map<string, string>()
  for (const [table, ids] of wanted) {
    if (ids.size === 0) continue
    // The label expression comes from the table above, never from a request.
    const column = Object.values(RELATION_TARGETS).find((t) => t.table === table)?.label ?? 'name'
    const expression = column.includes('(') ? column : `"${column}"`
    const found = await tx.execute<{ id: string; label: string | null }>(
      sql`select id, ${sql.raw(expression)} as label from ${sql.raw(`"${table}"`)} where id in (${sql.join([...ids].map((id) => sql`${id}`), sql`, `)})`,
    )
    for (const row of found) labels.set(row.id, row.label ?? '')
  }
  return labels
}

export type ListInput = {
  object: string
  columns?: string[]
  filters?: FilterGroup[]
  sorts?: Sort[]
  search?: string
  limit?: number
  cursor?: Cursor | null
}

export type ListRow = {
  id: string
  displayName: string
  values: RecordValues
  /** Relation and user values as their readable label, keyed by the same field key. */
  labels: Record<string, string>
}

export type ListPage = { rows: ListRow[]; nextCursor: Cursor | null; columns: RegistryField[] }

/** The one read path behind every table, board column, CSV export and MCP list. */
export const listRecords = async (
  ctx: WorkspaceContext,
  input: ListInput,
): Promise<ListPage> => {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  const scope = scopeFor(ctx.actorId)

  return withWorkspace(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, input.object)
    const columns = columnsFor(object, input.columns)
    const plan = orderPlan(object, input.sorts ?? [])

    const selected = [
      sql.raw(`"${object.key}"."id" as "id"`),
      ...columns.map((field) => selectExpression(object, field)),
      ...displayFields(object)
        .filter((field) => !columns.some((c) => c.key === field.key))
        .map((field) => selectExpression(object, field)),
      ...(plan.cursorValue && !columns.some((c) => c.key === plan.cursorValue)
        ? [selectExpression(object, fieldOrThrow(object, plan.cursorValue))]
        : []),
    ]

    const where: SQL[] = [NOT_DELETED(object)]
    const filters = compileFilters(object, input.filters ?? [], scope)
    if (filters) where.push(filters)
    if (input.search?.trim()) {
      where.push(sql`${sql.raw(`"${object.key}"."search"`)} @@ plainto_tsquery('simple', ${input.search.trim()})`)
    }
    if (input.cursor) where.push(plan.keysetWhere(input.cursor))

    const rows = await tx.execute<RecordValues & { id: string }>(sql`
      select ${sql.join(selected, sql`, `)}
        from ${sql.raw(`"${object.key}"`)}
       where ${sql.join(where, sql` and `)}
       order by ${plan.orderBy}
       limit ${limit + 1}`)

    const page = rows.slice(0, limit)
    const more = rows.length > limit
    const labels = await resolveLabels(tx, columns, page)

    return {
      columns,
      nextCursor:
        more && page.at(-1)
          ? {
              value: plan.cursorValue ? cursorValueOf(page.at(-1)!, plan.cursorValue) : null,
              id: String(page.at(-1)!.id),
            }
          : null,
      rows: page.map((row) => ({
        id: String(row.id),
        displayName: displayName(object.key, row),
        values: row,
        labels: Object.fromEntries(
          columns
            .filter((field) => RELATION_TARGETS[field.key] && typeof row[field.key] === 'string')
            .map((field) => [field.key, labels.get(String(row[field.key])) ?? '']),
        ),
      })),
    }
  })
}

const cursorValueOf = (row: RecordValues, key: string): string | number | null => {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') return value
  return String(value)
}

/** The fields the display name is built from, always fetched so a row can be
 *  labelled even when the chosen columns do not include a name. */
const displayFields = (object: RegistryObject): RegistryField[] => {
  const keys = object.key === 'contact' ? ['first_name', 'last_name', 'email'] : ['name', 'domain']
  return keys.flatMap((key) => {
    const field = object.byKey.get(key)
    return field ? [fieldOrThrow(object, field.key)] : []
  })
}

const columnsFor = (object: RegistryObject, requested?: string[]): RegistryField[] => {
  if (!requested || requested.length === 0) {
    return object.fields.slice(0, 8).map((field) => fieldOrThrow(object, field.key))
  }
  return requested.flatMap((key) => (object.byKey.has(key) ? [fieldOrThrow(object, key)] : []))
}

export type RecordDetail = {
  id: string
  objectKey: ObjectKey
  displayName: string
  values: RecordValues
  labels: Record<string, string>
  updatedAt: Date
  createdAt: Date
}

export const getRecord = async (
  ctx: WorkspaceContext,
  objectKey: string,
  id: string,
): Promise<RecordDetail | null> =>
  withWorkspace(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, objectKey)
    const fields = object.fields.map((field) => fieldOrThrow(object, field.key))

    const [row] = await tx.execute<RecordValues & { id: string; updated_at: Date; created_at: Date }>(sql`
      select ${sql.raw(`"${object.key}"."id" as "id", "${object.key}"."updated_at" as "updated_at"`)},
             ${sql.join(fields.map((field) => selectExpression(object, field)), sql`, `)}
        from ${sql.raw(`"${object.key}"`)}
       where ${sql.raw(`"${object.key}"."id"`)} = ${id} and ${NOT_DELETED(object)}
       limit 1`)

    if (!row) return null
    const labels = await resolveLabels(tx, fields, [row])

    return {
      id: String(row.id),
      objectKey: object.key,
      displayName: displayName(object.key, row),
      values: row,
      updatedAt: asDate(row.updated_at),
      createdAt: asDate(row.created_at),
      labels: Object.fromEntries(
        fields
          .filter((field) => RELATION_TARGETS[field.key] && typeof row[field.key] === 'string')
          .map((field) => [field.key, labels.get(String(row[field.key])) ?? '']),
      ),
    }
  })

type Prepared = { columns: Record<string, unknown>; custom: Record<string, unknown>; warnings: string[] }

/** Splits a values object into real columns and jsonb, coercing every value through
 *  the registry on the way. Unknown keys are refused, not ignored: a typo that
 *  silently writes nothing is worse than an error. */
const prepare = (object: RegistryObject, values: RecordValues): Prepared => {
  const prepared: Prepared = { columns: {}, custom: {}, warnings: [] }
  for (const [key, raw] of Object.entries(values)) {
    const field = fieldOrThrow(object, key)
    const { value, warning } = coerce(field, raw)
    if (warning) prepared.warnings.push(warning)
    if (field.storage === 'column') prepared.columns[field.columnName!] = value
    else prepared.custom[field.key] = value
  }
  return prepared
}

/** The one place a JavaScript value becomes a bound parameter.
 *
 *  Drizzle's raw execute path hands parameters to postgres.js unprepared, and that
 *  path serialises neither Date nor object values: a Date throws, and an object
 *  arrives as "[object Object]". Both are converted here so no caller has to
 *  remember, and so a datetime field and a jsonb blob behave the same everywhere. */
const bind = (value: unknown): SQL => {
  if (value instanceof Date) return sql`${value.toISOString()}::timestamptz`
  if (value !== null && typeof value === 'object') return sql`${JSON.stringify(value)}::jsonb`
  return sql`${value}`
}

const quotedAssignments = (columns: Record<string, unknown>): SQL[] =>
  Object.entries(columns).map(([column, value]) => sql`${sql.raw(`"${column}"`)} = ${bind(value)}`)

/** Contact on lower(email), company on registrable domain. The unique index is what
 *  actually enforces this; looking first only lets us name the other record. */
const findDuplicate = async (
  tx: Tx,
  object: RegistryObject,
  columns: Record<string, unknown>,
  excludeId?: string,
): Promise<{ id: string; what: string } | null> => {
  const checks: { column: string; value: unknown; what: string; caseInsensitive?: boolean }[] = []
  if (object.key === 'contact' && columns.email) {
    checks.push({ column: 'email', value: columns.email, what: `The email ${String(columns.email)}`, caseInsensitive: true })
  }
  if (object.key === 'company' && columns.domain) {
    checks.push({ column: 'domain', value: columns.domain, what: `The domain ${String(columns.domain)}` })
  }

  for (const check of checks) {
    const column = sql.raw(`"${check.column}"`)
    const [found] = await tx.execute<{ id: string }>(sql`
      select id from ${sql.raw(`"${object.key}"`)}
       where ${check.caseInsensitive ? sql`lower(${column}) = lower(${check.value})` : sql`${column} = ${check.value}`}
         and deleted_at is null
         ${excludeId ? sql`and id <> ${excludeId}` : sql``}
       limit 1`)
    if (found) return { id: found.id, what: check.what }
  }
  return null
}

/** Files a contact under the company its email domain implies, creating that company
 *  when it is not known yet. A free or disposable domain creates nothing, so
 *  gmail.com never becomes a company called Gmail. A4. */
const autoAssociateCompany = async (
  tx: Tx,
  ctx: WorkspaceContext,
  email: unknown,
): Promise<{ companyId: string; created: boolean } | null> => {
  const domain = employerDomainFromEmail(typeof email === 'string' ? email : null)
  if (!domain) return null

  const [existing] = await tx.execute<{ id: string }>(
    sql`select id from company where domain = ${domain} and deleted_at is null limit 1`,
  )
  if (existing) return { companyId: existing.id, created: false }

  const [created] = await tx.execute<{ id: string }>(sql`
    insert into company (workspace_id, name, domain)
    values (${ctx.workspaceId}, ${companyNameFromDomain(domain)}, ${domain})
    on conflict do nothing
    returning id`)

  if (created) return { companyId: created.id, created: true }

  // Lost a race with a concurrent insert; the winner's row is the answer.
  const [raced] = await tx.execute<{ id: string }>(
    sql`select id from company where domain = ${domain} and deleted_at is null limit 1`,
  )
  return raced ? { companyId: raced.id, created: false } : null
}

export type CreateResult = { id: string; warnings: string[]; autoCompanyId?: string | undefined }

export const createRecord = async (
  ctx: WorkspaceContext,
  objectKey: string,
  values: RecordValues,
): Promise<CreateResult> => {
  assertCanWrite(ctx, objectKey)
  return withWorkspace(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, objectKey)
    const prepared = prepare(object, values)

    for (const field of object.fields) {
      if (!field.isRequired) continue
      const present =
        field.storage === 'column'
          ? prepared.columns[field.columnName!] != null
          : prepared.custom[field.key] != null
      if (!present) throw new ValueError(field, 'is required.')
    }

    const duplicate = await findDuplicate(tx, object, prepared.columns)
    if (duplicate) throw new DuplicateError(duplicate.what, duplicate.id)

    let autoCompanyId: string | undefined
    if (object.key === 'contact' && !prepared.columns.company_id) {
      const linked = await autoAssociateCompany(tx, ctx, prepared.columns.email)
      if (linked) {
        prepared.columns.company_id = linked.companyId
        autoCompanyId = linked.companyId
      }
    }

    const columns = { ...prepared.columns, workspace_id: ctx.workspaceId, custom: prepared.custom }
    const names = Object.keys(columns).map((c) => sql.raw(`"${c}"`))
    const values_ = Object.values(columns).map(bind)

    const [row] = await tx.execute<{ id: string }>(sql`
      insert into ${sql.raw(`"${object.key}"`)} (${sql.join(names, sql`, `)})
      values (${sql.join(values_, sql`, `)})
      returning id`)

    if (!row) throw new Error(`The ${object.nameSingular.toLowerCase()} could not be created.`)

    const name = displayName(object.key, values)
    await writeAudit(tx, ctx, {
      entity: object.key,
      entityId: row.id,
      action: 'create',
      before: null,
      after: values,
    })
    await recordActivity(tx, ctx, {
      type: 'field_change',
      subject: `${name} was created`,
      links: linksFor(object.key, row.id, prepared.columns),
    })

    return { id: row.id, warnings: prepared.warnings, autoCompanyId }
  })
}

/** A change on a deal belongs on the deal, its company and, through the deal's
 *  contacts, on those too. Kept to the direct references here; the association
 *  table fans a note out further at the point it is written. */
const linksFor = (
  objectKey: ObjectKey,
  id: string,
  columns: Record<string, unknown>,
): { entityType: EntityType; entityId: string }[] => {
  const links: { entityType: EntityType; entityId: string }[] = [{ entityType: objectKey, entityId: id }]
  if (typeof columns.company_id === 'string') {
    links.push({ entityType: 'company', entityId: columns.company_id })
  }
  return links
}

export type UpdateResult = { updatedAt: Date; warnings: string[] }

/** Last write wins, but conditional on updated_at. A stale write is refused with
 *  what changed rather than silently overwriting someone else's edit. */
export const updateRecord = async (
  ctx: WorkspaceContext,
  objectKey: string,
  id: string,
  values: RecordValues,
  expectedUpdatedAt?: Date | null,
): Promise<UpdateResult> => {
  assertCanWrite(ctx, objectKey)
  return withWorkspace(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, objectKey)
    const prepared = prepare(object, values)
    if (Object.keys(prepared.columns).length === 0 && Object.keys(prepared.custom).length === 0) {
      throw new Error('Nothing was changed.')
    }

    const before = await readForWrite(tx, object, id)
    if (!before) throw new Error('That record no longer exists.')
    if (expectedUpdatedAt && before.updated_at.getTime() !== expectedUpdatedAt.getTime()) {
      throw new ConflictError(before.updated_at)
    }

    const duplicate = await findDuplicate(tx, object, prepared.columns, id)
    if (duplicate) throw new DuplicateError(duplicate.what, duplicate.id)

    const assignments = quotedAssignments(prepared.columns)
    if (Object.keys(prepared.custom).length > 0) {
      assignments.push(sql`"custom" = coalesce("custom", '{}'::jsonb) || ${JSON.stringify(prepared.custom)}::jsonb`)
    }
    assignments.push(sql`"updated_at" = now()`)

    const [row] = await tx.execute<{ updated_at: unknown }>(sql`
      update ${sql.raw(`"${object.key}"`)}
         set ${sql.join(assignments, sql`, `)}
       where id = ${id} and deleted_at is null
       returning updated_at`)

    if (!row) throw new Error('That record no longer exists.')

    await writeAudit(tx, ctx, {
      entity: object.key,
      entityId: id,
      action: 'update',
      before: pick(before, Object.keys(values), object),
      after: values,
    })
    await writeChangeActivities(tx, ctx, object, id, before, values)

    return { updatedAt: asDate(row.updated_at), warnings: prepared.warnings }
  })
}

/** Timestamps come back from the raw execute path as strings, not Dates, so every
 *  read normalises them before anything compares or subtracts them. */
const asDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)))

const readForWrite = async (
  tx: Tx,
  object: RegistryObject,
  id: string,
): Promise<(RecordValues & { updated_at: Date }) | undefined> => {
  const fields = object.fields.map((field) => fieldOrThrow(object, field.key))
  const [row] = await tx.execute<RecordValues & { updated_at: Date }>(sql`
    select ${sql.raw(`"${object.key}"."updated_at"`)},
           ${sql.join(fields.map((field) => selectExpression(object, field)), sql`, `)}
      from ${sql.raw(`"${object.key}"`)}
     where ${sql.raw(`"${object.key}"."id"`)} = ${id} and ${NOT_DELETED(object)}
     limit 1`)
  if (!row) return undefined
  return { ...row, updated_at: asDate(row.updated_at), created_at: asDate(row.created_at) }
}

const pick = (row: RecordValues, keys: string[], object: RegistryObject): RecordValues =>
  Object.fromEntries(keys.filter((key) => object.byKey.has(key)).map((key) => [key, row[key] ?? null]))

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date || b instanceof Date) {
    const left = a instanceof Date ? a.getTime() : new Date(String(a)).getTime()
    const right = b instanceof Date ? b.getTime() : new Date(String(b)).getTime()
    return left === right
  }
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
  if (a === null || a === undefined) return b === null || b === undefined || b === ''
  return String(a) === String(b)
}

/** A stage move reads "Trevor moved MGG from Meeting Booked to Interest" with nobody
 *  typing it. Only fields marked track_changes produce a row. A3. */
const writeChangeActivities = async (
  tx: Tx,
  ctx: WorkspaceContext,
  object: RegistryObject,
  id: string,
  before: RecordValues,
  after: RecordValues,
): Promise<void> => {
  const links = linksFor(object.key, id, {
    company_id: after.company_id ?? before.company_id,
  })
  const name = displayName(object.key, { ...before, ...after })

  for (const [key, next] of Object.entries(after)) {
    const field = object.byKey.get(key)
    if (!field?.trackChanges) continue
    const previous = before[key]
    if (sameValue(previous, next)) continue

    const [fromLabel, toLabel] = await Promise.all([
      labelOf(tx, key, previous),
      labelOf(tx, key, next),
    ])

    const type =
      key === 'stage_id' ? 'stage_change' : key === 'lifecycle_stage_id' ? 'lifecycle_change' : 'field_change'
    const sentence =
      type === 'stage_change'
        ? `moved ${name} from ${fromLabel || 'no stage'} to ${toLabel || 'no stage'}`
        : type === 'lifecycle_change'
          ? `moved ${name} to ${toLabel || 'no lifecycle stage'}`
          : `changed ${field.label} on ${name} from ${fromLabel || 'empty'} to ${toLabel || 'empty'}`

    await recordActivity(tx, ctx, {
      type,
      subject: sentence,
      payload: { field: key, from: previous ?? null, to: next ?? null, fromLabel, toLabel },
      links,
    })
  }
}

const labelOf = async (tx: Tx, fieldKey: string, value: unknown): Promise<string> => {
  if (value === null || value === undefined || value === '') return ''
  const target = RELATION_TARGETS[fieldKey]
  if (!target || typeof value !== 'string') {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value)
  }
  const expression = target.label.includes('(') ? target.label : `"${target.label}"`
  const [row] = await tx.execute<{ label: string | null }>(
    sql`select ${sql.raw(expression)} as label from ${sql.raw(`"${target.table}"`)} where id = ${value} limit 1`,
  )
  return row?.label ?? ''
}

/** Soft delete. Activity is retained, and the timeline entry keeps reading as the
 *  name the record had, so history is never silently rewritten. */
export const deleteRecord = async (
  ctx: WorkspaceContext,
  objectKey: string,
  id: string,
): Promise<void> =>
  mutate(ctx, objectKey, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, objectKey)
    const before = await readForWrite(tx, object, id)
    if (!before) throw new Error('That record has already been deleted.')

    await tx.execute(
      sql`update ${sql.raw(`"${object.key}"`)} set deleted_at = now(), updated_at = now() where id = ${id} and deleted_at is null`,
    )

    // Views are detached rather than deleted, so aggregate counts stay honest.
    // Erasure is a separate, explicit action. F4's edge case table.
    if (object.key === 'contact') {
      for (const table of ['page_view', 'custom_event', 'visitor'] as const) {
        await tx.execute(sql`
          update ${sql.raw(table)} set contact_id = null
           where workspace_id = ${ctx.workspaceId} and contact_id = ${id}`)
      }
    }

    return {
      result: undefined,
      audit: {
        entity: object.key,
        entityId: id,
        action: 'delete',
        before: { deletedAt: null, name: displayName(object.key, before) },
        after: { deletedAt: 'now' },
      },
    }
  })

export type MergeInput = {
  objectKey: string
  survivorId: string
  absorbedId: string
  /** field key -> which record's value wins. Absent keys keep the survivor's. */
  picks: Record<string, 'survivor' | 'absorbed'>
}

export type MergeResult = { id: string; activitiesMoved: number }

/** Not reversible, and the UI says so before it runs. Everything the absorbed
 *  record carried moves: activity, associations, subscriptions, segments and
 *  tasks. The older created_at wins, because that is when the relationship
 *  actually started. A4. */
export const mergeRecords = async (
  ctx: WorkspaceContext,
  input: MergeInput,
): Promise<MergeResult> => {
  assertCanWrite(ctx, input.objectKey)
  if (input.survivorId === input.absorbedId) {
    throw new Error('A record cannot be merged into itself.')
  }

  return withWorkspace(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, input.objectKey)
    const [survivor, absorbed] = await Promise.all([
      readForWrite(tx, object, input.survivorId),
      readForWrite(tx, object, input.absorbedId),
    ])
    if (!survivor) throw new Error('The record being kept no longer exists.')
    if (!absorbed) throw new Error('The record being merged no longer exists.')

    const absorbedName = displayName(object.key, absorbed)

    // The absorbed row goes first so its email or domain frees the unique index
    // before the survivor tries to claim it.
    await tx.execute(
      sql`update ${sql.raw(`"${object.key}"`)} set deleted_at = now(), updated_at = now() where id = ${input.absorbedId}`,
    )

    const chosen: RecordValues = {}
    for (const [key, side] of Object.entries(input.picks)) {
      if (!object.byKey.has(key)) continue
      chosen[key] = side === 'absorbed' ? absorbed[key] : survivor[key]
    }

    const prepared = prepare(object, chosen)
    const assignments = quotedAssignments(prepared.columns)
    if (Object.keys(prepared.custom).length > 0) {
      assignments.push(sql`"custom" = coalesce("custom", '{}'::jsonb) || ${JSON.stringify(prepared.custom)}::jsonb`)
    }
    const older =
      asDate(survivor.created_at) <= asDate(absorbed.created_at)
        ? asDate(survivor.created_at)
        : asDate(absorbed.created_at)
    assignments.push(sql`"created_at" = ${bind(older)}`)
    assignments.push(sql`"updated_at" = now()`)

    await tx.execute(sql`
      update ${sql.raw(`"${object.key}"`)}
         set ${sql.join(assignments, sql`, `)}
       where id = ${input.survivorId}`)

    const activitiesMoved = await moveActivityLinks(
      tx,
      ctx,
      { entityType: object.key, entityId: input.absorbedId },
      { entityType: object.key, entityId: input.survivorId },
    )
    await moveRelated(tx, ctx, object.key, input.absorbedId, input.survivorId)
    // A merged contact keeps their browsing history. Without this the visitor
    // aliases and the denormalised contact_id on both event tables would still
    // point at the record that no longer exists. F4 §3.
    if (object.key === 'contact') {
      await moveVisitorHistory(tx, ctx, input.absorbedId, input.survivorId)
    }

    await writeAudit(tx, ctx, {
      entity: object.key,
      entityId: input.survivorId,
      action: 'merge',
      before: { absorbed: absorbedName, absorbedId: input.absorbedId },
      after: { picks: input.picks },
    })
    await recordActivity(tx, ctx, {
      type: 'merge',
      subject: `${absorbedName} was merged into this record`,
      payload: { absorbedId: input.absorbedId, absorbedName, picks: input.picks },
      links: [{ entityType: object.key, entityId: input.survivorId }],
    })

    return { id: input.survivorId, activitiesMoved }
  })
}

/** Associations, tasks, subscriptions and segment memberships follow the survivor.
 *  Each is de-duplicated first for the same reason activity links are. */
const moveRelated = async (
  tx: Tx,
  ctx: WorkspaceContext,
  objectKey: ObjectKey,
  fromId: string,
  toId: string,
): Promise<void> => {
  await tx.execute(sql`
    delete from association a
     where a.workspace_id = ${ctx.workspaceId}
       and ((a.from_type = ${objectKey} and a.from_id = ${fromId} and exists (
              select 1 from association k where k.workspace_id = a.workspace_id
                and k.from_type = a.from_type and k.from_id = ${toId}
                and k.to_type = a.to_type and k.to_id = a.to_id))
         or (a.to_type = ${objectKey} and a.to_id = ${fromId} and exists (
              select 1 from association k where k.workspace_id = a.workspace_id
                and k.to_type = a.to_type and k.to_id = ${toId}
                and k.from_type = a.from_type and k.from_id = a.from_id)))`)
  await tx.execute(
    sql`update association set from_id = ${toId} where from_type = ${objectKey} and from_id = ${fromId}`,
  )
  await tx.execute(
    sql`update association set to_id = ${toId} where to_type = ${objectKey} and to_id = ${fromId}`,
  )
  await tx.execute(
    sql`update task set entity_id = ${toId} where entity_type = ${objectKey} and entity_id = ${fromId}`,
  )

  if (objectKey === 'contact') {
    await tx.execute(sql`
      delete from subscription_state s
       where s.workspace_id = ${ctx.workspaceId} and s.contact_id = ${fromId}
         and exists (select 1 from subscription_state k
                      where k.workspace_id = s.workspace_id and k.contact_id = ${toId}
                        and k.subscription_type_id = s.subscription_type_id)`)
    await tx.execute(sql`update subscription_state set contact_id = ${toId} where contact_id = ${fromId}`)
  }
  if (objectKey === 'company') {
    await tx.execute(sql`update contact set company_id = ${toId} where company_id = ${fromId}`)
    await tx.execute(sql`update deal set company_id = ${toId} where company_id = ${fromId}`)
  }
  await tx.execute(
    sql`update segment_membership set entity_id = ${toId} where entity_id = ${fromId}`,
  )
}

export type { Registry, RegistryField, RegistryObject }
