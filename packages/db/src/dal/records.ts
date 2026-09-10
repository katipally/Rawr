import { sql, type SQL } from 'drizzle-orm'
import type { ObjectKey } from '../registry/core.ts'
import { moveActivityLinks, recordActivity, type EntityType } from './activity.ts'
import { notify } from './notifications.ts'
import { moveVisitorHistory } from './stitch.ts'
import type { AccountContext } from './context.ts'
import { assertCanDo, assertCanWrite } from './context.ts'
import { scoreDeal } from './deal-score.ts'
import { companyNameFromDomain, employerDomainFromEmail } from './domains.ts'
import { requestEnrichment } from './enrichment.ts'
import { isUuid, mutate, withAccount, writeAudit, type Tx } from './index.ts'
import {
  compileFilters,
  fieldExpression,
  orderPlan,
  scopeFor,
  type Cursor,
  type FilterGroup,
  type Sort,
} from './query.ts'
import {
  assertCore,
  fieldOrThrow,
  getRegistry,
  getRegistryIn,
  objectOrThrow,
  rowsOf,
  tableFor,
  type Registry,
  type RegistryField,
  type RegistryObject,
} from './registry.ts'
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
/** What a record is called.
 *
 *  The core three each have their own rule, because a contact is a first and a
 *  last name falling back to an email and a company is a name falling back to a
 *  domain — neither of which is expressible as "one field". A custom object has
 *  no such rule, so the admin picks the field, and `labelFieldKey` is it.
 *
 *  Takes the object rather than its key, which is what makes both possible. */
export const displayName = (object: RegistryObject, values: RecordValues): string => {
  if (object.isCustom) {
    const named = object.labelFieldKey ? values[object.labelFieldKey] : null
    const text = named === null || named === undefined ? '' : String(named).trim()
    return text || `Unnamed ${object.nameSingular.toLowerCase()}`
  }
  if (object.key === 'contact') {
    const full = [values.first_name, values.last_name].filter(Boolean).join(' ').trim()
    return full || String(values.email ?? '') || 'Unnamed contact'
  }
  if (object.key === 'company') {
    return String(values.name ?? '') || String(values.domain ?? '') || 'Unnamed company'
  }
  return String(values.name ?? '') || 'Unnamed deal'
}

/** What a custom record is findable by.
 *
 *  Every textual value it holds, in one vector. A core table generates its own
 *  from named columns and Postgres keeps it in step; the shared table cannot,
 *  because the fields are whatever the admin made and a generated expression
 *  cannot know them. So it is written on every write.
 *
 *  Built from a jsonb expression rather than from the values in hand, which is
 *  what lets the insert and the update share it. An update merges the incoming
 *  keys into the stored blob, so the vector has to come from the merged result:
 *  computing it from the incoming keys alone would drop every word in a field
 *  this particular write did not touch.
 *
 *  'simple' rather than a stemming dictionary, matching the core tables: stemming
 *  mangles company and person names, which is most of what anybody searches. */
const searchVectorFrom = (object: RegistryObject, blob: SQL): SQL => {
  const parts = object.fields
    .filter((field) => TEXTUAL_FOR_SEARCH.has(field.type))
    .map((field) => sql`${blob} ->> ${field.key}`)
  if (parts.length === 0) return sql`to_tsvector('simple'::regconfig, '')`
  return sql`to_tsvector('simple'::regconfig, concat_ws(' ', ${sql.join(parts, sql`, `)}))`
}

/** The types worth putting in a search vector. A number or a date is found by
 *  filtering, not by typing it into a search box. */
const TEXTUAL_FOR_SEARCH: ReadonlySet<string> = new Set([
  'text',
  'long_text',
  'rich_text',
  'email',
  'phone',
  'url',
  'linkedin',
  'address',
  'select',
])

const selectExpression = (object: RegistryObject, field: RegistryField): SQL =>
  sql`${fieldExpression(object, field)} as ${sql.raw(`"${field.key}"`)}`

/** Live rows of this object, and only this object.
 *
 *  The second half is what a shared table needs and a core table does not: a
 *  custom object's rows sit beside every other custom object's, so the predicate
 *  that keeps them apart travels with the one that hides deleted rows. Bundled so
 *  no query can remember one and forget the other. */
const NOT_DELETED = (object: RegistryObject): SQL =>
  sql`${sql.raw(`"${object.key}"."deleted_at" is null`)} and ${rowsOf(object)}`

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
  /** Ask for the matching-row count alongside the page. Off by default: the
   *  board reads one query per stage and an export reads every page, and
   *  neither has anywhere to show it. */
  count?: boolean
}

export type ListRow = {
  id: string
  displayName: string
  values: RecordValues
  /** Relation and user values as their readable label, keyed by the same field key. */
  labels: Record<string, string>
}

export type ListPage = {
  rows: ListRow[]
  nextCursor: Cursor | null
  columns: RegistryField[]
  /** How many rows the filter matches, not how many this page holds. Null when
   *  the caller did not ask, because an export streaming every page has no use
   *  for the same count once per page. */
  total: number | null
}

/** The one read path behind every table, board column, CSV export and MCP list. */
export const listRecords = async (
  ctx: AccountContext,
  input: ListInput,
): Promise<ListPage> => {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  const scope = scopeFor(ctx.actorId)

  const registry = await getRegistry(ctx)
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
  // Counted before the cursor narrows it, so page two still says how many rows
  // the filter matches rather than how many are left. Its own transaction, so
  // it runs alongside the page instead of ahead of it.
  const counting = input.count
    ? withAccount(ctx, async (tx) =>
        Number(
          (
            await tx.execute<{ n: string }>(sql`
              select count(*) as n
                from ${tableFor(object)}
               where ${sql.join(where, sql` and `)}`)
          )[0]?.n ?? 0,
        ),
      )
    : Promise.resolve(null)

  const pageWhere = input.cursor ? [...where, plan.keysetWhere(input.cursor)] : where

  const [total, { rows, labels }] = await Promise.all([
    counting,
    withAccount(ctx, async (tx) => {
      const rows = await tx.execute<RecordValues & { id: string }>(sql`
        select ${sql.join(selected, sql`, `)}
          from ${tableFor(object)}
         where ${sql.join(pageWhere, sql` and `)}
         order by ${plan.orderBy}
         limit ${limit + 1}`)
      return { rows, labels: await resolveLabels(tx, columns, rows.slice(0, limit)) }
    }),
  ])

  {
    const page = rows.slice(0, limit)
    const more = rows.length > limit

    return {
      columns,
      total,
      nextCursor:
        more && page.at(-1)
          ? {
              value: plan.cursorValue ? cursorValueOf(page.at(-1)!, plan.cursorValue) : null,
              id: String(page.at(-1)!.id),
            }
          : null,
      rows: page.map((row) => ({
        id: String(row.id),
        displayName: displayName(object, row),
        values: row,
        labels: Object.fromEntries(
          columns
            .filter((field) => RELATION_TARGETS[field.key] && typeof row[field.key] === 'string')
            .map((field) => [field.key, labels.get(String(row[field.key])) ?? '']),
        ),
      })),
    }
  }
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
  /** Not `ObjectKey`: an admin can invent an object, and a record of one is
   *  read, edited and deleted through exactly these functions. */
  objectKey: string
  displayName: string
  values: RecordValues
  labels: Record<string, string>
  updatedAt: Date
  createdAt: Date
}

export const getRecord = async (
  ctx: AccountContext,
  objectKey: string,
  id: string,
): Promise<RecordDetail | null> => {
  if (!isUuid(id)) return null
  return withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, objectKey)
    const fields = object.fields.map((field) => fieldOrThrow(object, field.key))

    const [row] = await tx.execute<RecordValues & { id: string; updated_at: Date; created_at: Date }>(sql`
      select ${sql.raw(`"${object.key}"."id" as "id", "${object.key}"."updated_at" as "updated_at"`)},
             ${sql.join(fields.map((field) => selectExpression(object, field)), sql`, `)}
        from ${tableFor(object)}
       where ${sql.raw(`"${object.key}"."id"`)} = ${id} and ${NOT_DELETED(object)}
       limit 1`)

    if (!row) return null
    const labels = await resolveLabels(tx, fields, [row])

    return {
      id: String(row.id),
      objectKey: object.key,
      displayName: displayName(object, row),
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
}

type Prepared = { columns: Record<string, unknown>; custom: Record<string, unknown>; warnings: string[] }

/** Splits a values object into real columns and jsonb, coercing every value through
 *  the registry on the way. Unknown keys are refused, not ignored: a typo that
 *  silently writes nothing is worse than an error. */
const prepare = (object: RegistryObject, values: RecordValues): Prepared => {
  const prepared: Prepared = { columns: {}, custom: {}, warnings: [] }
  for (const [key, raw] of Object.entries(values)) {
    const field = fieldOrThrow(object, key)
    // Refused here rather than by hiding the input, so the API and the MCP tools
    // are held to the same rule as the record page.
    if (field.isSystem) {
      throw new ValueError(field, 'is maintained by Rawr and cannot be edited.')
    }
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
      select id from ${tableFor(object)}
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
  ctx: AccountContext,
  email: unknown,
): Promise<{ companyId: string; created: boolean } | null> => {
  const domain = employerDomainFromEmail(typeof email === 'string' ? email : null)
  if (!domain) return null

  const [existing] = await tx.execute<{ id: string }>(
    sql`select id from company where domain = ${domain} and deleted_at is null limit 1`,
  )
  if (existing) return { companyId: existing.id, created: false }

  const [created] = await tx.execute<{ id: string }>(sql`
    insert into company (account_id, name, domain)
    values (${ctx.accountId}, ${companyNameFromDomain(domain)}, ${domain})
    on conflict do nothing
    returning id`)

  if (created) return { companyId: created.id, created: true }

  // Lost a race with a concurrent insert; the winner's row is the answer.
  const [raced] = await tx.execute<{ id: string }>(
    sql`select id from company where domain = ${domain} and deleted_at is null limit 1`,
  )
  return raced ? { companyId: raced.id, created: false } : null
}

/** A deal's stage and pipeline are one fact told twice, and the stage is the
 *  half a person picks. So the pipeline follows the stage: a stage alone sets
 *  its pipeline, a pipeline alone lands the deal on that pipeline's first stage,
 *  and the two named together must agree. Neither half is read from the client
 *  as true, because a stage from another pipeline would vanish from every board. */
const reconcileDeal = async (
  tx: Tx,
  columns: Record<string, unknown>,
  current: { pipeline_id: string | null; stage_id: string | null } | null,
): Promise<void> => {
  const stageId = typeof columns.stage_id === 'string' ? columns.stage_id : null
  const pipelineId = typeof columns.pipeline_id === 'string' ? columns.pipeline_id : null

  if (stageId) {
    const [stage] = await tx.execute<{ pipeline_id: string }>(
      sql`select pipeline_id from pipeline_stage where id = ${stageId} limit 1`,
    )
    if (!stage) throw new Error('That deal stage does not exist.')
    if (pipelineId && pipelineId !== stage.pipeline_id) {
      throw new Error('That deal stage is not in that pipeline. Pick a stage from the pipeline, or change the pipeline first.')
    }
    columns.pipeline_id = stage.pipeline_id
    return
  }

  const target = pipelineId ?? current?.pipeline_id ?? null
  // A new pipeline with no stage named, or a new deal with neither: the first
  // stage of the pipeline, which is where HubSpot starts a deal too.
  if (target === (current?.pipeline_id ?? null) && current) return
  const [first] = await tx.execute<{ id: string; pipeline_id: string }>(target
    ? sql`select id, pipeline_id from pipeline_stage where pipeline_id = ${target} order by position asc limit 1`
    : sql`select s.id, s.pipeline_id from pipeline_stage s join pipeline p on p.id = s.pipeline_id order by p.position asc, s.position asc limit 1`)
  if (!first) throw new Error('That pipeline has no stages. An admin adds them in Settings, under Pipelines.')
  columns.pipeline_id = first.pipeline_id
  columns.stage_id = first.id
}

/** The one key an enricher matches on. A write that sets or changes it is a
 *  reason to ask again; every other write is not. */
const matchKeyOf = (objectKey: string, columns: Record<string, unknown>): unknown =>
  objectKey === 'contact' ? columns.email : objectKey === 'company' ? columns.domain : undefined

export type CreateResult = {
  id: string
  warnings: string[]
  autoCompanyId?: string | undefined
  /** What the record goes by. Returned rather than looked up again by the caller,
   *  because an automation that names the record in a Slack message wants the
   *  name it had when it fired. */
  displayName: string
}

/** An import writes tens of thousands of rows in a run, and asking a person to
 *  approve a queue that size is not a question, it is a wall. So the importer
 *  turns this off and the records it writes are enriched on a later edit, or one
 *  at a time from the record itself. Every other path asks. */
export type WriteOptions = { enrich?: boolean }

/** A record has to be findable by somebody who did not create it. Neither of
 *  these columns can be marked required on its own -- an import of company
 *  domains has no names, and a form capture has an email and no name -- so the
 *  rule is "one of", checked once here rather than at each of the four writers.
 *
 *  A deal is absent because its name already is required outright. */
const IDENTITY: Record<string, { columns: string[]; message: string }> = {
  contact: { columns: ['email', 'first_name', 'last_name'], message: 'A contact needs an email or a name.' },
  company: { columns: ['name', 'domain'], message: 'A company needs a name or a domain.' },
}

const assertIdentified = (object: RegistryObject, columns: Record<string, unknown>): void => {
  const rule = IDENTITY[object.key]
  if (!rule) return
  const named = rule.columns.some((column) => {
    const value = columns[column]
    return typeof value === 'string' ? value.trim() !== '' : value != null
  })
  if (!named) throw new Error(rule.message)
}

export const createRecord = async (
  ctx: AccountContext,
  objectKey: string,
  values: RecordValues,
  options: WriteOptions = {},
): Promise<CreateResult> => {
  assertCanWrite(ctx, objectKey)
  return withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, objectKey)
    const prepared = prepare(object, values)
    // What was reconciled is what was written, so the audit row and the display
    // name describe the deal as stored rather than the half that was sent.
    const written = object.key === 'deal' ? await reconcileDeal(tx, prepared.columns, null).then(() => ({ ...values, pipeline_id: prepared.columns.pipeline_id, stage_id: prepared.columns.stage_id })) : values

    for (const field of object.fields) {
      if (!field.isRequired) continue
      const present =
        field.storage === 'column'
          ? prepared.columns[field.columnName!] != null
          : prepared.custom[field.key] != null
      if (!present) throw new ValueError(field, 'is required.')
    }

    assertIdentified(object, prepared.columns)

    const duplicate = await findDuplicate(tx, object, prepared.columns)
    if (duplicate) throw new DuplicateError(duplicate.what, duplicate.id)

    let autoCompanyId: string | undefined
    if (object.key === 'contact' && !prepared.columns.company_id) {
      const linked = await autoAssociateCompany(tx, ctx, prepared.columns.email)
      if (linked) {
        prepared.columns.company_id = linked.companyId
        autoCompanyId = linked.companyId
        if (linked.created && options.enrich !== false) await requestEnrichment(tx, ctx, 'company', linked.companyId)
      }
    }

    const columns: Record<string, unknown> = {
      ...prepared.columns,
      account_id: ctx.accountId,
      custom: prepared.custom,
      // Which object this row is one of. Only a shared-table row needs it; a
      // core record's table already answers the question.
      ...(object.isCustom ? { object_id: object.id } : {}),
    }
    const names = Object.keys(columns).map((c) => sql.raw(`"${c}"`))
    const values_: SQL[] = Object.values(columns).map(bind)

    // A core table's search column is generated, so Postgres keeps it in step on
    // its own. The shared table cannot be: which field names a record is the
    // admin's choice, and a generated expression cannot know it. So it is
    // written here, on the same statement, rather than left to drift.
    if (object.isCustom) {
      names.push(sql.raw('"search"'))
      values_.push(searchVectorFrom(object, sql`${JSON.stringify(prepared.custom)}::jsonb`))
    }

    const [row] = await tx.execute<{ id: string }>(sql`
      insert into ${tableFor(object)} (${sql.join(names, sql`, `)})
      values (${sql.join(values_, sql`, `)})
      returning id`)

    if (!row) throw new Error(`The ${object.nameSingular.toLowerCase()} could not be created.`)
    if (options.enrich !== false && (object.key === 'contact' || object.key === 'company') && matchKeyOf(object.key, prepared.columns)) {
      await requestEnrichment(tx, ctx, object.key, row.id)
    }

    const name = displayName(object, written)
    await writeAudit(tx, ctx, {
      entity: object.key,
      entityId: row.id,
      action: 'create',
      before: null,
      after: written,
    })
    await recordActivity(tx, ctx, {
      type: 'field_change',
      subject: `created ${name}`,
      links: linksFor(object.key, row.id, prepared.columns),
    })

    return { id: row.id, warnings: prepared.warnings, autoCompanyId, displayName: displayName(object, written) }
  })
}

/** A change on a deal belongs on the deal, its company and, through the deal's
 *  contacts, on those too. Kept to the direct references here; the association
 *  table fans a note out further at the point it is written. */
const linksFor = (
  objectKey: string,
  id: string,
  columns: Record<string, unknown>,
): { entityType: EntityType; entityId: string }[] => {
  const links: { entityType: EntityType; entityId: string }[] = [{ entityType: objectKey, entityId: id }]
  if (typeof columns.company_id === 'string') {
    links.push({ entityType: 'company', entityId: columns.company_id })
  }
  return links
}

export type StageChange = {
  activityId: string
  dealId: string
  dealName: string
  from: string
  to: string
  pipelineId: string | null
}

export type UpdateResult = {
  updatedAt: Date
  warnings: string[]
  /** Set when this write moved a deal's stage. Returned rather than announced from
   *  here: telling Slack is F6's job, and the data access layer must not know that
   *  Slack exists. */
  stageChange?: StageChange | undefined
  /** True when this write moved a lifecycle stage. B11's second trigger, and
   *  reported the same way and for the same reason as the first. */
  lifecycleChanged: boolean
  /** What the record goes by after the write. */
  displayName: string
}

/** Last write wins, but conditional on updated_at. A stale write is refused with
 *  what changed rather than silently overwriting someone else's edit. */
export const updateRecord = async (
  ctx: AccountContext,
  objectKey: string,
  id: string,
  values: RecordValues,
  expectedUpdatedAt?: Date | null,
  options: WriteOptions = {},
): Promise<UpdateResult> => {
  assertCanWrite(ctx, objectKey)
  return withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, objectKey)
    return updateRecordIn(tx, ctx, object, id, values, expectedUpdatedAt ?? null, options)
  })
}

/** The write itself, inside a transaction the caller already owns. Split out so a
 *  bulk edit can apply the same rules — coercion, conflict, dedupe, audit, change
 *  activity — to many records without opening a transaction per row. */
const updateRecordIn = async (
  tx: Tx,
  ctx: AccountContext,
  object: RegistryObject,
  id: string,
  values: RecordValues,
  expectedUpdatedAt: Date | null,
  options: WriteOptions = {},
): Promise<UpdateResult> => {
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
  if (object.key === 'deal') {
    await reconcileDeal(tx, prepared.columns, {
      pipeline_id: typeof before.pipeline_id === 'string' ? before.pipeline_id : null,
      stage_id: typeof before.stage_id === 'string' ? before.stage_id : null,
    })
  }
  // What was reconciled is what was written, so the audit row and the stage
  // change on the timeline describe the move rather than the half that was sent.
  const written =
    object.key === 'deal'
      ? { ...values, ...Object.fromEntries(['pipeline_id', 'stage_id'].filter((key) => prepared.columns[key] !== undefined).map((key) => [key, prepared.columns[key]])) }
      : values

  const assignments = quotedAssignments(prepared.columns)
  const merged = sql`coalesce("custom", '{}'::jsonb) || ${JSON.stringify(prepared.custom)}::jsonb`
  if (Object.keys(prepared.custom).length > 0) {
    assignments.push(sql`"custom" = ${merged}`)
    // Rebuilt from the merged blob in the same statement, so a record cannot be
    // left findable by a name it no longer has. A core table's is generated and
    // needs nothing here.
    if (object.isCustom) assignments.push(sql`"search" = ${searchVectorFrom(object, merged)}`)
  }
  assignments.push(sql`"updated_at" = now()`)

  const [row] = await tx.execute<{ updated_at: unknown }>(sql`
    update ${tableFor(object)}
       set ${sql.join(assignments, sql`, `)}
     where id = ${id} and deleted_at is null
     returning updated_at`)

  if (!row) throw new Error('That record no longer exists.')
  const key = options.enrich === false ? undefined : matchKeyOf(object.key, prepared.columns)
  if ((object.key === 'contact' || object.key === 'company') && key && key !== before[object.key === 'contact' ? 'email' : 'domain']) {
    await requestEnrichment(tx, ctx, object.key, id)
  }

  await writeAudit(tx, ctx, {
    entity: object.key,
    entityId: id,
    action: 'update',
    before: pick(before, Object.keys(written), object),
    after: written,
  })
  const changes = await writeChangeActivities(tx, ctx, object, id, before, written)
  // Stage probability is the heaviest rule in the score, so a card that lands in
  // a new column must not carry the number it had in the old one. Every other
  // input moves on its own and waits for the nightly pass.
  if (changes.stageChange) await scoreDeal(tx, id)

  return {
    updatedAt: asDate(row.updated_at),
    warnings: prepared.warnings,
    stageChange: changes.stageChange,
    lifecycleChanged: changes.lifecycleChanged,
    displayName: displayName(object, { ...before, ...written }),
  }
}

export type BulkUpdateResult = {
  updated: number
  /** Named per record so a partial run is legible rather than "some failed". */
  failed: { id: string; displayName: string; reason: string }[]
  /** What each record held before, for the fields this edit touched. The one
   *  thing an undo needs, and the one thing the caller cannot work out
   *  afterwards. */
  previous: { id: string; values: RecordValues }[]
}

const BULK_MAX = 500

/** One field set applied to a selection. A5.
 *
 *  A row that cannot take the change does not stop the rest: a bulk edit over
 *  fifty records where two carry a duplicate email should write forty-eight and
 *  say which two it did not. Each record is written in its own savepoint so a
 *  failure rolls back only that row, and every one still writes its own audit
 *  entry and its own change activity. */
export const bulkUpdateRecords = async (
  ctx: AccountContext,
  objectKey: string,
  ids: string[],
  values: RecordValues,
): Promise<BulkUpdateResult> => {
  assertCanWrite(ctx, objectKey)
  const unique = [...new Set(ids)]
  if (unique.length === 0) throw new Error('Nothing was selected.')
  if (unique.length > BULK_MAX) {
    throw new Error(`That is ${unique.length} records in one edit; ${BULK_MAX} is the limit. Narrow the selection.`)
  }
  if (Object.keys(values).length === 0) throw new Error('Pick a field to change first.')

  return withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, objectKey)
    const result: BulkUpdateResult = { updated: 0, failed: [], previous: [] }

    const changed = Object.keys(values)
    for (const id of unique) {
      const point = `bulk_${result.updated + result.failed.length}`
      await tx.execute(sql.raw(`savepoint "${point}"`))
      try {
        // Read before the write, so the caller can offer to put it back. One
        // record's worth of columns, not the whole row: an undo restores what
        // this edit touched and nothing somebody else changed in between.
        const before = await readForWrite(tx, object, id).catch(() => undefined)
        await updateRecordIn(tx, ctx, object, id, values, null)
        await tx.execute(sql.raw(`release savepoint "${point}"`))
        result.updated += 1
        if (before) {
          result.previous.push({
            id,
            values: Object.fromEntries(changed.map((key) => [key, before[key] ?? null])),
          })
        }
      } catch (cause) {
        await tx.execute(sql.raw(`rollback to savepoint "${point}"`))
        const row = await readForWrite(tx, object, id).catch(() => undefined)
        result.failed.push({
          id,
          displayName: row ? displayName(object, row) : id,
          reason: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }

    return result
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
      from ${tableFor(object)}
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
  ctx: AccountContext,
  object: RegistryObject,
  id: string,
  before: RecordValues,
  after: RecordValues,
): Promise<{ stageChange: StageChange | undefined; lifecycleChanged: boolean }> => {
  let stageChange: StageChange | undefined
  let lifecycleChanged = false
  const links = linksFor(object.key, id, {
    company_id: after.company_id ?? before.company_id,
  })
  const name = displayName(object, { ...before, ...after })

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

    const activityId = await recordActivity(tx, ctx, {
      type,
      subject: sentence,
      payload: { field: key, from: previous ?? null, to: next ?? null, fromLabel, toLabel },
      links,
    })

    if (type === 'lifecycle_change') lifecycleChanged = true
    if (type === 'stage_change' && activityId) {
      // The deal's owner, in the same transaction as the move. Not through
      // stage-alerts.ts: that one is opt-in per pipeline and gated on Slack being
      // configured, and an in-app notice must not disappear because it is not.
      const owner = after.owner_id ?? before.owner_id
      if (typeof owner === 'string') {
        await notify(tx, ctx, {
          kind: 'deal_stage_change',
          dedupeKey: `deal:stage:${activityId}`,
          title: `${name} moved to ${toLabel || 'no stage'}`,
          body: `From ${fromLabel || 'no stage'}.`,
          entity: object.key,
          entityId: id,
          to: { userIds: [owner] },
        })
      }
      stageChange = {
        activityId,
        dealId: id,
        dealName: name,
        from: fromLabel || 'no stage',
        to: toLabel || 'no stage',
        pipelineId:
          typeof after.pipeline_id === 'string'
            ? after.pipeline_id
            : typeof before.pipeline_id === 'string'
              ? before.pipeline_id
              : null,
      }
    }
  }

  return { stageChange, lifecycleChanged }
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
  ctx: AccountContext,
  objectKey: string,
  id: string,
): Promise<void> => {
  assertCanDo(ctx, 'delete')
  return mutate(ctx, objectKey, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, objectKey)
    const name = await deleteRecordIn(tx, ctx, object, id)

    return {
      result: undefined,
      audit: {
        entity: object.key,
        entityId: id,
        action: 'delete',
        before: { deletedAt: null, name },
        after: { deletedAt: 'now' },
      },
    }
  })
}

/** The delete itself, without the transaction or the audit row, so a bulk delete
 *  can run many of these under one transaction and still audit each one. Returns
 *  the name the record had, which is what the audit entry records. */
const deleteRecordIn = async (
  tx: Tx,
  ctx: AccountContext,
  object: RegistryObject,
  id: string,
): Promise<string> => {
  const before = await readForWrite(tx, object, id)
  if (!before) throw new Error('That record has already been deleted.')

  await tx.execute(
    sql`update ${tableFor(object)} set deleted_at = now(), updated_at = now() where id = ${id} and deleted_at is null`,
  )

  // A question about a record nobody kept is not a question. Left behind it
  // would inflate the number the consent prompt asks somebody to approve, and
  // then fail against a record that is gone.
  await tx.execute(
    sql`delete from enrichment_request where entity = ${object.key} and entity_id = ${id}`,
  )

  // Views are detached rather than deleted, so aggregate counts stay honest.
  // Erasure is a separate, explicit action. F4's edge case table.
  if (object.key === 'contact') {
    for (const table of ['page_view', 'custom_event', 'visitor'] as const) {
      await tx.execute(sql`
        update ${sql.raw(table)} set contact_id = null
         where account_id = ${ctx.accountId} and contact_id = ${id}`)
    }
  }

  return displayName(object, before)
}

export type BulkDeleteResult = { deleted: number; failed: { id: string; reason: string }[] }

/** A selection deleted in one transaction, a savepoint each, for the same reason
 *  a bulk edit is: a record somebody has already deleted must not take the other
 *  four hundred and ninety-nine with it. Every one still writes its own audit row.
 *
 *  O(n) statements in n ids, which is what a soft delete that also detaches
 *  browsing history costs; the caller chunks so no one transaction is long. */
export const bulkDeleteRecords = async (
  ctx: AccountContext,
  objectKey: string,
  ids: string[],
): Promise<BulkDeleteResult> => {
  assertCanWrite(ctx, objectKey)
  assertCanDo(ctx, 'bulk_delete')
  const unique = [...new Set(ids)]
  if (unique.length === 0) throw new Error('Nothing was selected.')

  return withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, objectKey)
    const result: BulkDeleteResult = { deleted: 0, failed: [] }

    for (const id of unique) {
      const point = `bulk_delete_${result.deleted + result.failed.length}`
      await tx.execute(sql.raw(`savepoint "${point}"`))
      try {
        const name = await deleteRecordIn(tx, ctx, object, id)
        await writeAudit(tx, ctx, {
          entity: object.key,
          entityId: id,
          action: 'delete',
          before: { deletedAt: null, name },
          after: { deletedAt: 'now' },
        })
        await tx.execute(sql.raw(`release savepoint "${point}"`))
        result.deleted += 1
      } catch (cause) {
        await tx.execute(sql.raw(`rollback to savepoint "${point}"`))
        result.failed.push({ id, reason: cause instanceof Error ? cause.message : String(cause) })
      }
    }

    return result
  })
}

/** Refuses a selection that names records this account cannot see, by count, so
 *  a bulk action carrying an id from another tenant stops before it writes rather
 *  than silently doing less than it was asked to. Row-level security is what makes
 *  the count honest: another account's record is not visible to read either. */
export const assertIdsBelong = async (
  tx: Tx,
  object: RegistryObject,
  ids: string[],
): Promise<void> => {
  // A Postgres array literal, not a JavaScript array: drizzle expands the latter
  // into one placeholder per element, which is a syntax error inside `any()`.
  const [row] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from ${tableFor(object)}
     where id = any(${`{${ids.join(',')}}`}::uuid[]) and ${NOT_DELETED(object)}`)
  const found = Number(row?.n ?? 0)
  if (found !== ids.length) {
    throw new Error(
      `${ids.length - found} of ${ids.length} selected ${object.namePlural.toLowerCase()} are not in this account, so nothing was changed.`,
    )
  }
}

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
  ctx: AccountContext,
  input: MergeInput,
): Promise<MergeResult> => {
  assertCanWrite(ctx, input.objectKey)
  assertCanDo(ctx, 'merge')
  if (input.survivorId === input.absorbedId) {
    throw new Error('A record cannot be merged into itself.')
  }

  return withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, input.objectKey)
    const [survivor, absorbed] = await Promise.all([
      readForWrite(tx, object, input.survivorId),
      readForWrite(tx, object, input.absorbedId),
    ])
    if (!survivor) throw new Error('The record being kept no longer exists.')
    if (!absorbed) throw new Error('The record being merged no longer exists.')

    const absorbedName = displayName(object, absorbed)

    // The absorbed row goes first so its email or domain frees the unique index
    // before the survivor tries to claim it.
    await tx.execute(
      sql`update ${tableFor(object)} set deleted_at = now(), updated_at = now() where id = ${input.absorbedId}`,
    )
    await tx.execute(
      sql`delete from enrichment_request where entity = ${object.key} and entity_id = ${input.absorbedId}`,
    )

    const chosen: RecordValues = {}
    for (const [key, side] of Object.entries(input.picks)) {
      const field = object.byKey.get(key)
      // created_at is decided below by which record is older, so a pick on it is
      // meaningless and prepare() would refuse it anyway.
      if (!field || field.isSystem) continue
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
      update ${tableFor(object)}
         set ${sql.join(assignments, sql`, `)}
       where id = ${input.survivorId}`)

    // Merging moves activities, associations and browsing history, none of
    // which a custom object has yet. Refused with a sentence rather than
    // half-run.
    const coreKey = assertCore(object, 'be merged')
    const activitiesMoved = await moveActivityLinks(
      tx,
      ctx,
      { entityType: coreKey, entityId: input.absorbedId },
      { entityType: coreKey, entityId: input.survivorId },
    )
    await moveRelated(tx, ctx, coreKey, input.absorbedId, input.survivorId)
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
      subject: `merged ${absorbedName} into this record`,
      payload: { absorbedId: input.absorbedId, absorbedName, picks: input.picks },
      links: [{ entityType: coreKey, entityId: input.survivorId }],
    })

    return { id: input.survivorId, activitiesMoved }
  })
}

/** Associations, tasks, subscriptions and segment memberships follow the survivor.
 *  Each is de-duplicated first for the same reason activity links are. */
const moveRelated = async (
  tx: Tx,
  ctx: AccountContext,
  objectKey: ObjectKey,
  fromId: string,
  toId: string,
): Promise<void> => {
  await tx.execute(sql`
    delete from association a
     where a.account_id = ${ctx.accountId}
       and ((a.from_type = ${objectKey} and a.from_id = ${fromId} and exists (
              select 1 from association k where k.account_id = a.account_id
                and k.from_type = a.from_type and k.from_id = ${toId}
                and k.to_type = a.to_type and k.to_id = a.to_id))
         or (a.to_type = ${objectKey} and a.to_id = ${fromId} and exists (
              select 1 from association k where k.account_id = a.account_id
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
       where s.account_id = ${ctx.accountId} and s.contact_id = ${fromId}
         and exists (select 1 from subscription_state k
                      where k.account_id = s.account_id and k.contact_id = ${toId}
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
