import { createHash } from 'node:crypto'
import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import { importRun } from '../schema/imports.ts'
import { activity, activityLink } from '../schema/records.ts'
import {
  ACTIVITY_IMPORT,
  hubspotActivityPreset,
  hubspotPreset,
  looksLikeHubspot,
} from '../registry/hubspot.ts'
import type { ObjectKey } from '../registry/core.ts'
import type { WorkspaceContext } from './context.ts'
import { assertCanWrite } from './context.ts'
import { isUuid, mutate, withWorkspace } from './index.ts'
import { createRecord, updateRecord, DuplicateError } from './records.ts'
import { getRegistry, objectOrThrow, type RegistryField, type RegistryObject } from './registry.ts'
import { coerce, ValueError } from './values.ts'

export type ImportRow = Record<string, string>
/** csv header -> field key, or null for a column the person chose to ignore. */
export type Mapping = Record<string, string | null>

export type RowError = { row: number; reason: string; values: ImportRow }

/** Records fill columns on a record; activities land on its timeline. */
export type ImportKind = 'records' | 'activities'

/** The column a run is matched on. Without it a second run of the same file
 *  creates everything again instead of updating it, which is why the mapper
 *  refuses to start until it is mapped. */
const dedupeKeyOf = (kind: ImportKind, objectKey: string): string =>
  kind === 'activities' ? 'contact_email' : objectKey === 'contact' ? 'email' : objectKey === 'company' ? 'domain' : 'name'

export type ImportSummary = {
  id: string
  filename: string
  headers: string[]
  objectType: ObjectKey
  importKind: ImportKind
  source: string | null
  state: 'mapping' | 'previewing' | 'running' | 'done' | 'failed' | 'cancelled'
  totalRows: number
  processedRows: number
  created: number
  updated: number
  skipped: number
  errored: number
  errors: RowError[]
  lastError: string | null
  createdAt: Date
  finishedAt: Date | null
}

/** Header names plus their count. The same weekly export is mapped once, and the
 *  next upload of it offers that mapping back. A8. */
export const fileSignature = (objectType: string, headers: string[]): string =>
  `${objectType}:${headers.length}:${headers.map((h) => h.trim().toLowerCase()).join('|')}`

/** A best guess so the mapper opens with the obvious columns already matched.
 *  Exact key, then exact label, then a loose match on letters only. */
/** A best guess so the mapper opens with the obvious columns already matched.
 *  A preset from a known export wins over the guess, because "Associated Company"
 *  is a company on a contact and no amount of loose matching says so. */
export const suggestMapping = (
  object: RegistryObject,
  headers: string[],
  preset: Record<string, string | null> = {},
): Mapping => {
  const loose = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
  const byKey = new Map(object.fields.map((field) => [field.key, field.key]))
  const byLabel = new Map(object.fields.map((field) => [loose(field.label), field.key]))
  const byLooseKey = new Map(object.fields.map((field) => [loose(field.key), field.key]))

  const mapping: Mapping = {}
  const taken = new Set<string>()
  for (const header of Object.values(preset)) {
    if (header) taken.add(header)
  }
  for (const header of headers) {
    if (header in preset) {
      mapping[header] = preset[header] ?? null
      continue
    }
    const candidate =
      byKey.get(header.trim()) ?? byLabel.get(loose(header)) ?? byLooseKey.get(loose(header)) ?? null
    // Two headers mapping to one field is blocked in the mapper, so the second
    // one is left unmapped rather than silently overwriting the first. A8.
    mapping[header] = candidate && !taken.has(candidate) ? candidate : null
    if (candidate && !taken.has(candidate)) taken.add(candidate)
  }
  return mapping
}

export const assertMappingIsUsable = (
  object: RegistryObject,
  mapping: Mapping,
  kind: ImportKind = 'records',
): void => {
  const seen = new Map<string, string>()
  for (const [header, key] of Object.entries(mapping)) {
    if (!key) continue
    if (!object.byKey.has(key)) {
      throw new Error(`${object.namePlural} has no field called "${key}".`)
    }
    const previous = seen.get(key)
    if (previous) {
      throw new Error(
        `"${previous}" and "${header}" are both mapped to ${object.byKey.get(key)?.label}. Pick one.`,
      )
    }
    seen.set(key, header)
  }
  if (seen.size === 0) throw new Error('Map at least one column before importing.')

  const dedupeKey = dedupeKeyOf(kind, object.key)
  if (!seen.has(dedupeKey)) {
    throw new Error(
      kind === 'activities'
        ? 'Map a column to Contact email. Without it there is no record to put these on.'
        : `Map a column to ${object.byKey.get(dedupeKey)?.label ?? dedupeKey}. Without it every run creates duplicates instead of updating.`,
    )
  }
  if (kind === 'activities' && !seen.has('occurred_at')) {
    throw new Error('Map a column to Activity date. A timeline entry with no date has nowhere to sit.')
  }
}

/** Where a spreadsheet's words for a relation are looked up. A HubSpot export
 *  carries the owner's name, the company's name and the stage's label, never an
 *  id, so each is matched on what a person would type. Only a company is created
 *  when nothing matches: a stage or an owner that does not exist is a mistake in
 *  the file, a company that does not exist is the point of the import. */
const RELATION_LOOKUPS: Record<string, { what: string; find: (needle: string) => SQL }> = {
  owner_id: {
    what: 'member',
    find: (needle) => sql`select u.id from user_account u join membership m on m.user_id = u.id
                          where lower(u.name) = lower(${needle}) or lower(u.email) = lower(${needle}) limit 1`,
  },
  company_id: {
    what: 'company',
    find: (needle) => sql`select id from company where deleted_at is null
                          and (lower(name) = lower(${needle}) or domain = lower(${needle}))
                          order by created_at limit 1`,
  },
  lifecycle_stage_id: {
    what: 'lifecycle stage',
    find: (needle) => sql`select id from lifecycle_stage where lower(name) = lower(${needle}) limit 1`,
  },
  pipeline_id: {
    what: 'pipeline',
    find: (needle) => sql`select id from pipeline where lower(name) = lower(${needle}) limit 1`,
  },
  stage_id: {
    what: 'deal stage',
    find: (needle) => sql`select id from pipeline_stage where lower(name) = lower(${needle}) limit 1`,
  },
}

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

/** Resolves the relation values in one run, remembering every answer so a file
 *  with 90,000 rows and 300 distinct companies costs 300 lookups, not 90,000.
 *  O(distinct values) queries, O(1) per row after the first.
 *
 *  Returns null for a company that does not exist yet when creating is off: the
 *  preview promises nothing has been written, so it reports the row without the
 *  company and the real run creates it. */
const relationResolver = (ctx: WorkspaceContext, options: { create: boolean }) => {
  const remembered = new Map<string, string | null>()
  return async (field: RegistryField, raw: string): Promise<string | null> => {
    const needle = raw.trim()
    if (isUuid(needle)) return needle
    const lookup = RELATION_LOOKUPS[field.key]
    if (!lookup) throw new ValueError(field, 'has to be picked from the list, not typed.')

    const cacheKey = `${field.key}\u0000${needle.toLowerCase()}`
    let id = remembered.get(cacheKey)
    if (id === undefined) {
      const [found] = await withWorkspace(ctx, (tx) => tx.execute<{ id: string }>(lookup.find(needle)))
      id = found?.id ?? null
      if (id === null && field.key === 'company_id') {
        if (!options.create) return null
        try {
          const created = await createRecord(ctx, 'company', DOMAIN.test(needle) ? { name: needle, domain: needle.toLowerCase() } : { name: needle })
          id = created.id
        } catch (cause) {
          if (!(cause instanceof DuplicateError)) throw cause
          id = cause.existingId
        }
      }
      remembered.set(cacheKey, id)
    }
    if (id === null) throw new ValueError(field, `no ${lookup.what} called "${needle}" exists in this workspace.`)
    return id
  }
}

type Resolve = ReturnType<typeof relationResolver>

/** Turns one spreadsheet row into what will happen to it. The dry run and the real
 *  run share this, so the preview cannot promise one thing and the run do another.
 *  The one write it can cause is a company named for the first time, and only the
 *  real run passes a resolver that creates. */
export const planRow = async (
  object: RegistryObject,
  mapping: Mapping,
  row: ImportRow,
  resolve: Resolve,
  kind: ImportKind = 'records',
): Promise<{ values: Record<string, unknown>; warnings: string[]; error?: string }> => {
  const values: Record<string, unknown> = {}
  const warnings: string[] = []
  const dedupeKey = dedupeKeyOf(kind, object.key)
  for (const [header, key] of Object.entries(mapping)) {
    if (!key) continue
    const raw = row[header]
    if (raw === undefined || raw === null || String(raw).trim() === '') continue
    const field = object.byKey.get(key)
    if (!field) continue
    try {
      const named = field.type === 'relation' || field.type === 'user' ? await resolve(field, String(raw)) : raw
      if (named === null) continue
      const { value, warning } = coerce(field, named)
      if (warning) warnings.push(warning)
      values[key] = value
    } catch (cause) {
      return {
        values,
        warnings,
        error: cause instanceof ValueError ? cause.message : String(cause),
      }
    }
  }
  if (Object.keys(values).length > 0 && !(dedupeKey in values)) {
    warnings.push(
      kind === 'activities'
        ? 'No contact email, so there is no record to put this on.'
        : `No ${object.byKey.get(dedupeKey)?.label ?? dedupeKey}, so this row cannot be matched to an existing record and will be created again on every run.`,
    )
  }
  return { values, warnings }
}

const dedupeLookup = async (
  ctx: WorkspaceContext,
  object: RegistryObject,
  values: Record<string, unknown>,
): Promise<string | null> => {
  const key = object.key === 'contact' ? 'email' : object.key === 'company' ? 'domain' : null
  const value = key ? values[key] : null
  if (!key || typeof value !== 'string' || !value) return null

  return withWorkspace(ctx, async (tx) => {
    const [found] = await tx.execute<{ id: string }>(
      key === 'email'
        ? sql`select id from contact where lower(email) = lower(${value}) and deleted_at is null limit 1`
        : sql`select id from company where domain = ${value} and deleted_at is null limit 1`,
    )
    return found?.id ?? null
  })
}

/** Activities are mapped against a fixed shape rather than the workspace's
 *  registry: nothing is created from those columns, they only say which record
 *  the note belongs to and what it said. */
const objectFor = async (
  ctx: WorkspaceContext,
  kind: ImportKind,
  objectKey: string,
): Promise<RegistryObject> =>
  kind === 'activities' ? ACTIVITY_IMPORT : objectOrThrow(await getRegistry(ctx), objectKey)

/** The header preset a file gets opened with. Named sources win; a file nobody
 *  labelled is still recognised when it carries HubSpot's own columns. */
const presetFor = (
  kind: ImportKind,
  objectKey: string,
  source: string | null,
  headers: string[],
): Record<string, string | null> => {
  if (source !== 'hubspot' && !looksLikeHubspot(headers)) return {}
  if (kind === 'activities') return hubspotActivityPreset(headers)
  return hubspotPreset(objectKey as ObjectKey, headers)
}

/** Stable across runs of the same file, so importing it twice leaves the timeline
 *  as it was. HubSpot numbers its engagements, and when a file does not, the row's
 *  own content is what identifies it. */
const importKeyOf = (source: string | null, values: Record<string, unknown>): string => {
  const external = values.external_id
  if (typeof external === 'string' && external.trim()) return `${source ?? 'csv'}:${external.trim()}`
  const parts = ['contact_email', 'occurred_at', 'subject', 'body'].map((key) => {
    const value = values[key]
    return value instanceof Date ? value.toISOString() : String(value ?? '')
  })
  return `${source ?? 'csv'}:${createHash('sha1').update(parts.join('\u0000')).digest('hex')}`
}

const ACTIVITY_KIND: Record<string, 'note' | 'email' | 'call' | 'meeting'> = {
  note: 'note',
  email: 'email',
  call: 'call',
  meeting: 'meeting',
}

/** Where an imported note or logged email attaches. Memoised per run for the same
 *  reason the relation resolver is: a file of 40,000 notes about 300 people costs
 *  300 lookups. */
const recordResolver = (ctx: WorkspaceContext) => {
  const remembered = new Map<string, { type: 'contact' | 'company'; id: string } | null>()
  return async (values: Record<string, unknown>) => {
    const email = typeof values.contact_email === 'string' ? values.contact_email.toLowerCase() : ''
    const domain = typeof values.company_domain === 'string' ? values.company_domain.toLowerCase() : ''
    const cacheKey = `${email}\u0000${domain}`
    const found = remembered.get(cacheKey)
    if (found !== undefined) return found

    const resolved = await withWorkspace(ctx, async (tx) => {
      if (email) {
        const [contact] = await tx.execute<{ id: string }>(
          sql`select id from contact where lower(email) = ${email} and deleted_at is null limit 1`,
        )
        if (contact) return { type: 'contact' as const, id: contact.id }
      }
      if (domain) {
        const [company] = await tx.execute<{ id: string }>(
          sql`select id from company where domain = ${domain} and deleted_at is null limit 1`,
        )
        if (company) return { type: 'company' as const, id: company.id }
      }
      return null
    })
    remembered.set(cacheKey, resolved)
    return resolved
  }
}

export type DryRun = {
  willCreate: number
  willUpdate: number
  willSkip: number
  willError: number
  samples: { create: ImportRow[]; update: ImportRow[]; error: RowError[] }
}

const SAMPLE_SIZE = 5
const PREVIEW_ROWS = 500

/** Counts over the whole file, worked examples over the first few hundred rows.
 *  Checking every row against the database before the run would double the work of
 *  the import for a number the person is about to confirm anyway. */
export const dryRun = async (
  ctx: WorkspaceContext,
  input: { objectKey: string; mapping: Mapping; rows: ImportRow[]; kind?: ImportKind },
): Promise<DryRun> => {
  const kind = input.kind ?? 'records'
  const object = await objectFor(ctx, kind, input.objectKey)
  assertMappingIsUsable(object, input.mapping, kind)

  const result: DryRun = {
    willCreate: 0,
    willUpdate: 0,
    willSkip: 0,
    willError: 0,
    samples: { create: [], update: [], error: [] },
  }

  const checked = input.rows.slice(0, PREVIEW_ROWS)
  const resolve = relationResolver(ctx, { create: false })
  const findRecord = recordResolver(ctx)
  for (const [index, row] of checked.entries()) {
    const planned = await planRow(object, input.mapping, row, resolve, kind)
    if (planned.error) {
      result.willError += 1
      if (result.samples.error.length < SAMPLE_SIZE) {
        result.samples.error.push({ row: index + 2, reason: planned.error, values: row })
      }
      continue
    }
    if (Object.keys(planned.values).length === 0) {
      result.willSkip += 1
      continue
    }
    // An activity is only ever created, and only when the record it names exists.
    // A row about somebody who is not in the CRM is reported, not invented.
    if (kind === 'activities') {
      const target = await findRecord(planned.values)
      if (target) {
        result.willCreate += 1
        if (result.samples.create.length < SAMPLE_SIZE) result.samples.create.push(row)
      } else {
        result.willError += 1
        if (result.samples.error.length < SAMPLE_SIZE) {
          result.samples.error.push({
            row: index + 2,
            reason: 'No contact or company in this workspace matches that address, so there is nothing to put this on.',
            values: row,
          })
        }
      }
      continue
    }
    const existing = await dedupeLookup(ctx, object, planned.values)
    if (existing) {
      result.willUpdate += 1
      if (result.samples.update.length < SAMPLE_SIZE) result.samples.update.push(row)
    } else {
      result.willCreate += 1
      if (result.samples.create.length < SAMPLE_SIZE) result.samples.create.push(row)
    }
  }

  // Rows beyond the sampled window are reported as creates rather than left out of
  // the totals, and the run itself still updates whatever already exists.
  const remaining = input.rows.length - checked.length
  if (remaining > 0) result.willCreate += remaining
  return result
}

export const createImportRun = async (
  ctx: WorkspaceContext,
  input: {
    objectKey: string
    filename: string
    headers: string[]
    rows: ImportRow[]
    mapping: Mapping
    kind?: ImportKind
    source?: string | null
  },
): Promise<{ id: string; suggested: Mapping; previousMapping: Mapping | null }> =>
  mutate(ctx, input.objectKey, async (tx) => {
    const kind = input.kind ?? 'records'
    const object = await objectFor(ctx, kind, input.objectKey)
    const signature = fileSignature(`${kind}:${object.key}`, input.headers)

    const [previous] = await tx
      .select({ mapping: importRun.mapping })
      .from(importRun)
      .where(and(eq(importRun.fileSignature, signature), eq(importRun.state, 'done')))
      .orderBy(desc(importRun.createdAt))
      .limit(1)

    const suggested = suggestMapping(
      object,
      input.headers,
      presetFor(kind, object.key, input.source ?? null, input.headers),
    )

    const [row] = await tx
      .insert(importRun)
      .values({
        workspaceId: ctx.workspaceId,
        objectType: kind === 'activities' ? 'contact' : object.key,
        importKind: kind,
        source: input.source ?? null,
        filename: input.filename,
        fileSignature: signature,
        headers: input.headers,
        // An empty mapping means "work it out": the caller has no view of the
        // preset, and re-deriving it in two places is how the two drift.
        mapping: Object.keys(input.mapping).length > 0 ? input.mapping : suggested,
        rows: input.rows,
        totalRows: input.rows.length,
        state: 'mapping',
        createdBy: ctx.actorId,
      })
      .returning({ id: importRun.id })
    if (!row) throw new Error('The import could not be started.')

    return {
      result: {
        id: row.id,
        suggested,
        previousMapping: (previous?.mapping as Mapping | undefined) ?? null,
      },
      audit: {
        entity: 'import_run',
        entityId: row.id,
        action: 'create',
        before: null,
        after: { filename: input.filename, rows: input.rows.length, kind, source: input.source ?? null },
      },
    }
  })

export const setImportMapping = async (
  ctx: WorkspaceContext,
  id: string,
  mapping: Mapping,
): Promise<void> =>
  mutate(ctx, 'import_run', async (tx) => {
    const [run] = await tx
      .select({ objectType: importRun.objectType, importKind: importRun.importKind })
      .from(importRun)
      .where(eq(importRun.id, id))
    if (!run) throw new Error('That import no longer exists.')
    assertMappingIsUsable(await objectFor(ctx, run.importKind, run.objectType), mapping, run.importKind)

    await tx
      .update(importRun)
      .set({ mapping, state: 'previewing', updatedAt: new Date() })
      .where(eq(importRun.id, id))

    return {
      result: undefined,
      audit: { entity: 'import_run', entityId: id, action: 'map', before: null, after: { mapping } },
    }
  })

/** One imported note or logged email. Written straight rather than through
 *  `recordActivity`, because that stamps the importing user as the person who made
 *  the call; these carry the file as their actor and the row's own date as when it
 *  happened. The unique import key is what makes a second run of the same export
 *  a no-op. */
const writeImportedActivity = async (
  ctx: WorkspaceContext,
  findRecord: ReturnType<typeof recordResolver>,
  source: string | null,
  values: Record<string, unknown>,
): Promise<'created' | 'already' | 'unmatched'> => {
  const target = await findRecord(values)
  if (!target) return 'unmatched'

  const occurredAt = values.occurred_at instanceof Date ? values.occurred_at : new Date()
  const type = ACTIVITY_KIND[String(values.activity_type ?? 'note')] ?? 'note'
  const key = importKeyOf(source, values)

  return withWorkspace(ctx, async (tx) => {
    // Written as SQL rather than through the query builder because the unique
    // index is partial, and Postgres only infers a partial index for ON CONFLICT
    // when the same predicate is repeated here. The index stays partial so it
    // covers imported rows rather than every activity ever written.
    const [row] = await tx.execute<{ id: string }>(sql`
      insert into activity (workspace_id, type, subject, body, occurred_at, actor_id, actor_kind, source, import_key)
      values (${ctx.workspaceId}::uuid, ${type}::rawr_activity_type,
              ${typeof values.subject === 'string' ? values.subject : null},
              ${typeof values.body === 'string' ? values.body : null},
              ${occurredAt.toISOString()}::timestamptz,
              ${ctx.actorId}::uuid, ${ctx.actorKind}::rawr_actor_kind,
              ${source ?? 'import'}, ${key})
      on conflict (workspace_id, import_key) where import_key is not null do nothing
      returning id`)
    if (!row) return 'already'

    await tx
      .insert(activityLink)
      .values({
        workspaceId: ctx.workspaceId,
        activityId: row.id,
        entityType: target.type,
        entityId: target.id,
        type,
        occurredAt,
      })
      .onConflictDoNothing()
    return 'created'
  })
}

const CHUNK = 200

/** One chunk of an import. Called repeatedly by the worker, so an interrupted run
 *  continues from processed_rows instead of restarting, and re-running the same
 *  file updates rather than duplicating because the dedupe key drives it. A8. */
export const runImportChunk = async (
  ctx: WorkspaceContext,
  id: string,
): Promise<{ done: boolean; processed: number; total: number }> => {
  assertCanWrite(ctx, 'contact')

  const [run] = await withWorkspace(ctx, (tx) =>
    tx
      .select({
        objectType: importRun.objectType,
        importKind: importRun.importKind,
        source: importRun.source,
        mapping: importRun.mapping,
        rows: importRun.rows,
        processedRows: importRun.processedRows,
        totalRows: importRun.totalRows,
        state: importRun.state,
        errors: importRun.errors,
      })
      .from(importRun)
      .where(eq(importRun.id, id))
      .limit(1),
  )
  if (!run) throw new Error('That import no longer exists.')
  if (run.state === 'done' || run.state === 'cancelled') {
    return { done: true, processed: run.processedRows, total: run.totalRows }
  }

  const kind = run.importKind
  const object = await objectFor(ctx, kind, run.objectType)
  const mapping = run.mapping as Mapping
  const rows = (run.rows as ImportRow[] | null) ?? []
  const slice = rows.slice(run.processedRows, run.processedRows + CHUNK)

  let created = 0
  let updated = 0
  let skipped = 0
  const errors: RowError[] = []
  const resolve = relationResolver(ctx, { create: true })
  const findRecord = recordResolver(ctx)

  for (const [offset, row] of slice.entries()) {
    const rowNumber = run.processedRows + offset + 2
    const planned = await planRow(object, mapping, row, resolve, kind)
    if (planned.error) {
      errors.push({ row: rowNumber, reason: planned.error, values: row })
      continue
    }
    if (Object.keys(planned.values).length === 0) {
      skipped += 1
      continue
    }
    for (const warning of planned.warnings) {
      errors.push({ row: rowNumber, reason: warning, values: row })
    }

    if (kind === 'activities') {
      const outcome = await writeImportedActivity(ctx, findRecord, run.source, planned.values)
      if (outcome === 'created') created += 1
      else if (outcome === 'already') skipped += 1
      else {
        errors.push({
          row: rowNumber,
          reason: 'No contact or company in this workspace matches that address, so there is nothing to put this on.',
          values: row,
        })
      }
      continue
    }

    try {
      const existing = await dedupeLookup(ctx, object, planned.values)
      if (existing) {
        await updateRecord(ctx, object.key, existing, planned.values)
        updated += 1
      } else {
        await createRecord(ctx, object.key, planned.values)
        created += 1
      }
    } catch (cause) {
      if (cause instanceof DuplicateError) {
        // Lost a race with another row in the same file. The row it collided with
        // holds the value, so this one is an update.
        try {
          await updateRecord(ctx, object.key, cause.existingId, planned.values)
          updated += 1
          continue
        } catch (retry) {
          errors.push({ row: rowNumber, reason: retry instanceof Error ? retry.message : String(retry), values: row })
          continue
        }
      }
      errors.push({ row: rowNumber, reason: cause instanceof Error ? cause.message : String(cause), values: row })
    }
  }

  const processed = run.processedRows + slice.length
  const done = processed >= rows.length
  const previousErrors = (run.errors as RowError[] | null) ?? []

  await withWorkspace(ctx, (tx) =>
    tx
      .update(importRun)
      .set({
        processedRows: processed,
        createdCount: sql`${importRun.createdCount} + ${created}`,
        updatedCount: sql`${importRun.updatedCount} + ${updated}`,
        skippedCount: sql`${importRun.skippedCount} + ${skipped}`,
        erroredCount: sql`${importRun.erroredCount} + ${errors.length}`,
        // Capped: a file where every row fails must not put a 90,000-entry array
        // in one column. The count stays exact.
        errors: [...previousErrors, ...errors].slice(0, 1000),
        state: done ? 'done' : 'running',
        finishedAt: done ? new Date() : null,
        // Rows are only useful while the run can still resume.
        rows: done ? null : (rows as never),
        updatedAt: new Date(),
      })
      .where(eq(importRun.id, id)),
  )

  return { done, processed, total: rows.length }
}

export const readImportRun = async (
  ctx: WorkspaceContext,
  id: string,
): Promise<ImportSummary | null> => {
  if (!isUuid(id)) return null
  const [row] = await withWorkspace(ctx, (tx) =>
    tx
      .select({
        id: importRun.id,
        filename: importRun.filename,
        headers: importRun.headers,
        objectType: importRun.objectType,
        importKind: importRun.importKind,
        source: importRun.source,
        state: importRun.state,
        totalRows: importRun.totalRows,
        processedRows: importRun.processedRows,
        created: importRun.createdCount,
        updated: importRun.updatedCount,
        skipped: importRun.skippedCount,
        errored: importRun.erroredCount,
        errors: importRun.errors,
        lastError: importRun.lastError,
        createdAt: importRun.createdAt,
        finishedAt: importRun.finishedAt,
      })
      .from(importRun)
      .where(eq(importRun.id, id))
      .limit(1),
  )
  if (!row) return null
  return {
    ...row,
    headers: (row.headers as string[] | null) ?? [],
    errors: (row.errors as RowError[] | null) ?? [],
  } as ImportSummary
}

export const listImportRuns = async (ctx: WorkspaceContext): Promise<ImportSummary[]> => {
  const rows = await withWorkspace(ctx, (tx) =>
    tx
      .select({
        id: importRun.id,
        filename: importRun.filename,
        objectType: importRun.objectType,
        importKind: importRun.importKind,
        source: importRun.source,
        state: importRun.state,
        totalRows: importRun.totalRows,
        processedRows: importRun.processedRows,
        created: importRun.createdCount,
        updated: importRun.updatedCount,
        skipped: importRun.skippedCount,
        errored: importRun.erroredCount,
        lastError: importRun.lastError,
        createdAt: importRun.createdAt,
        finishedAt: importRun.finishedAt,
      })
      .from(importRun)
      .orderBy(desc(importRun.createdAt))
      .limit(50),
  )
  return rows.map((row) => ({ ...row, headers: [], errors: [] })) as ImportSummary[]
}
