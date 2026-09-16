import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm'
import { importRow, importRun } from '../schema/imports.ts'
import { activityLink } from '../schema/records.ts'
import {
  ACTIVITY_IMPORT,
  ASSOCIATION_IMPORT,
  hubspotActivityPreset,
  hubspotFieldType,
  hubspotPreset,
  hubspotShapePreset,
  LIST_IMPORT,
  looksLikeHubspot,
  PROPERTY_IMPORT,
  SUBMISSION_IMPORT } from '../registry/hubspot.ts'
import type { ObjectKey } from '../registry/core.ts'
import type { FieldType } from '../registry/types.ts'
import {
  isNewProperty,
  MAX_CHOICES,
  MAX_OPTION_LENGTH,
  type Mapping,
  type NewProperty,
} from '../registry/mapping.ts'
import type { AccountContext } from './context.ts'
import { assertCanDo, assertCanWrite } from './context.ts'
import { isUuid, mutate, withAccount, type Tx } from './index.ts'
import { linksForContacts } from './activity.ts'
import { createField, createFields, updateField } from './admin-fields.ts'
import { orderedPair } from './associations.ts'
import { bulkWriteRecords, createRecord, updateRecord, DuplicateError, type BulkRow } from './records.ts'
import { getRegistry, objectOrThrow, type RegistryField, type RegistryObject } from './registry.ts'
import { assertUsableFieldKey } from './fields.ts'
import { choiceOf, coerce, ValueError } from './values.ts'

/** An import does not queue its rows for enrichment. A file of ninety thousand
 *  contacts would ask somebody to approve ninety thousand lookups in one modal,
 *  which is not a decision anybody can make; and the rows it writes are usually
 *  already enriched at the other end. Editing one afterwards asks as normal, and
 *  the button on a record still enriches that one. */
const NO_ENRICH = { enrich: false } as const

export type ImportRow = Record<string, string>

export { isNewProperty, MAX_CHOICES, MAX_OPTION_LENGTH, type Mapping, type NewProperty }

export type RowError = { row: number; reason: string; values: ImportRow }

/** One line of what a run said about a row, kept on the run for the screen. A
 *  warning is a row that was written with something changed; anything else is a
 *  row that was refused, and that row itself stays in import_row for the file. */
export type RunNote = { row: number; reason: string; warning?: true }

/** Records fill columns on a record; activities land on its timeline; the other
 *  four carry the shape around the records rather than the records themselves.
 *  B9: a portal exports every one of them as its own file. */
export const IMPORT_KINDS = [
  'records',
  'activities',
  'properties',
  'associations',
  'lists',
  'submissions',
] as const
export type ImportKind = (typeof IMPORT_KINDS)[number]

/** The column a run is matched on. Without it a second run of the same file
 *  creates everything again instead of updating it, which is why the mapper
 *  refuses to start until it is mapped. */
const DEDUPE_KEY: Partial<Record<ImportKind, string>> = {
  activities: 'contact_email',
  properties: 'label',
  associations: 'deal_name',
  lists: 'list_name',
  submissions: 'contact_email',
}

/** Exported so the import picker can name the column a file will be matched on
 *  before one is chosen, in the same words the mapper will use. */
export const dedupeKeyOf = (kind: ImportKind, object: RegistryObject): string => {
  const fixed = DEDUPE_KEY[kind]
  if (fixed) return fixed
  if (object.key === 'contact') return 'email'
  if (object.key === 'company') return 'domain'
  // An invented object is matched on whatever it is called by, which is the only
  // field of it every row is guaranteed to carry.
  return object.isCustom ? (object.labelFieldKey ?? 'name') : 'name'
}

/** What the mapper must carry beyond the dedupe key, and the sentence to say when
 *  it does not. One entry rather than a branch, because the reason differs per
 *  kind and a generic "map more columns" helps nobody. */
const ALSO_REQUIRED: Partial<Record<ImportKind, { key: string; because: string }>> = {
  activities: { key: 'occurred_at', because: 'Map a column to Activity date. A timeline entry with no date has nowhere to sit.' },
  properties: { key: 'object_key', because: 'Map a column to Applies to. Without it there is no way to tell a contact property from a deal one.' },
  associations: { key: 'contact_email', because: 'Map a column to Contact email. A deal with nobody on it is what this file exists to fix.' },
  lists: { key: 'contact_email', because: 'Map a column to Contact email. A list of nobody is not a list.' },
  submissions: { key: 'form_name', because: 'Map a column to Form. A submission has to belong to one.' },
}

/** The columns the mapper will refuse to start without, by key, for the kinds
 *  whose answer does not depend on the account's registry.
 *
 *  Exported so the picker can say what a file needs before one is chosen rather
 *  than after it is uploaded, and derived from the two maps above so the two
 *  sentences cannot drift apart. `records` is absent: what identifies a record
 *  is decided by the object it is going into. */
export const requiredColumnKeys = (kind: ImportKind): string[] =>
  [DEDUPE_KEY[kind], ALSO_REQUIRED[kind]?.key].filter((key): key is string => Boolean(key))

export type ImportSummary = {
  id: string
  filename: string
  headers: string[]
  /** The object's key. Since 0066 this may be one an admin invented. */
  objectType: string
  importKind: ImportKind
  source: string | null
  state: 'uploading' | 'mapping' | 'previewing' | 'running' | 'done' | 'failed' | 'cancelled'
  totalRows: number
  processedRows: number
  created: number
  updated: number
  skipped: number
  errored: number
  errors: RunNote[]
  /** Owner names in the file that match nobody here. Those rows landed
   *  unassigned rather than failing, so this is the list to act on. */
  unmatchedOwners: string[]
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
/** What people actually head a column with, where it is nothing like the field's
 *  own name. "Company" is the commonest header in any contact export and matches
 *  neither "company_id" nor "Primary company", so a file that names the company
 *  on every row opens with that column dismissed.
 *
 *  Only the headers that would otherwise miss. Anything the label or key already
 *  catches is not repeated here. */
const HEADER_SYNONYMS: Record<string, string> = {
  company: 'company_id',
  companyname: 'company_id',
  account: 'company_id',
  accountname: 'company_id',
  organisation: 'company_id',
  organization: 'company_id',
  employer: 'company_id',
  owner: 'owner_id',
  contactowner: 'owner_id',
  assignedto: 'owner_id',
  website: 'domain',
  websiteurl: 'domain',
  companydomain: 'domain',
  emailaddress: 'email',
  workemail: 'email',
  jobtitle: 'title',
  position: 'title',
  mobile: 'phone',
  phonenumber: 'phone',
  linkedin: 'linkedin_url',
}

const loose = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

/** A file can set a field unless Rawr keeps it up to date itself. Create date is
 *  the exception: a migration carries when each record really began, and only a
 *  new record takes it. */
export const isImportable = (field: RegistryField): boolean => !field.isSystem || field.key === 'created_at'

/** The field a header names: exact key, then label, then key, on letters only. */
const fieldNamed = (fields: RegistryField[], header: string): RegistryField | undefined =>
  fields.find((field) => field.key === header.trim()) ??
  fields.find((field) => loose(field.label) === loose(header)) ??
  fields.find((field) => loose(field.key) === loose(header))

export const suggestMapping = (
  object: RegistryObject,
  headers: string[],
  preset: Record<string, string | null> = {},
): Mapping => {
  const fields = object.fields.filter(isImportable)
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
    const synonym = HEADER_SYNONYMS[loose(header)]
    const candidate =
      fieldNamed(fields, header)?.key ??
      // Last, so a real field called "Website" always beats the synonym for it.
      (synonym && fields.some((field) => field.key === synonym) ? synonym : null)
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
  for (const [header, target] of Object.entries(mapping)) {
    if (!target) continue
    // A proposed property takes its key the moment the run starts, so it clashes
    // with an existing field and with another proposal exactly as a mapped
    // column does. Its key not being in the registry yet is the point of it.
    const key = isNewProperty(target) ? target.key : target
    const field = object.byKey.get(key)
    if (!isNewProperty(target) && !field) {
      throw new Error(`${object.namePlural} has no field called "${key}".`)
    }
    // Refused here rather than row by row: the run would turn every row down for
    // it while the preview, which writes nothing, said they would all land.
    if (field && !isImportable(field)) {
      throw new Error(`${field.label} is kept up to date by Rawr, so "${header}" cannot go into it. Pick another field or Do not import.`)
    }
    const previous = seen.get(key)
    if (previous) {
      throw new Error(
        `"${previous}" and "${header}" are both mapped to ${object.byKey.get(key)?.label ?? key}. Pick one.`,
      )
    }
    seen.set(key, header)
  }
  if (seen.size === 0) throw new Error('Map at least one column before importing.')

  const dedupeKey = dedupeKeyOf(kind, object)
  if (!seen.has(dedupeKey)) {
    throw new Error(
      kind === 'activities'
        ? 'Map a column to Contact email. Without it there is no record to put these on.'
        : `Map a column to ${object.byKey.get(dedupeKey)?.label ?? dedupeKey}. Without it every run creates duplicates instead of updating.`,
    )
  }
  const also = ALSO_REQUIRED[kind]
  if (also && !seen.has(also.key)) throw new Error(also.because)
}

/** Where a spreadsheet's words for a relation are looked up. A HubSpot export
 *  carries the owner's name, the company's name and the stage's label, never an
 *  id, so each is matched on what a person would type. Only a company is created
 *  when nothing matches: a stage or an owner that does not exist is a mistake in
 *  the file, a company that does not exist is the point of the import.
 *
 *  Each takes a list and answers every name in it at once, with the two lowercase
 *  spellings a row may use for the record, `a` and `b`. */
const RELATION_LOOKUPS: Record<string, { what: string; find: (names: SQL) => SQL }> = {
  owner_id: {
    what: 'member',
    find: (names) => sql`select u.id, lower(u.name) as a, lower(u.email) as b
                           from user_account u join membership m on m.user_id = u.id
                          where lower(u.name) in ${names} or lower(u.email) in ${names}`,
  },
  company_id: {
    what: 'company',
    find: (names) => sql`select id, lower(name) as a, domain as b from company
                          where deleted_at is null and (lower(name) in ${names} or domain in ${names})
                          order by created_at`,
  },
  lifecycle_stage_id: {
    what: 'lifecycle stage',
    find: (names) => sql`select id, lower(name) as a, null as b from lifecycle_stage where lower(name) in ${names}`,
  },
  pipeline_id: {
    what: 'pipeline',
    find: (names) => sql`select id, lower(name) as a, null as b from pipeline where lower(name) in ${names}`,
  },
  stage_id: {
    what: 'deal stage',
    find: (names) => sql`select id, lower(name) as a, null as b from pipeline_stage where lower(name) in ${names}`,
  },
}

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

/** Resolves the relation values in one run, remembering every answer, a miss
 *  included, so a file with 90,000 rows and 300 distinct companies asks about each
 *  company once. `prime` asks about a whole batch of rows in one query per
 *  relation, which is what keeps a preview of five hundred rows to a handful of
 *  round trips: O(relations) queries per batch, O(1) per row.
 *
 *  Returns null for a company that does not exist yet when creating is off: the
 *  preview promises nothing has been written, so it reports the row without the
 *  company and the real run creates it. */
const relationResolver = (ctx: AccountContext, options: { create: boolean }) => {
  const remembered = new Map<string, string | null>()
  const keyOf = (field: RegistryField, name: string) => `${field.key}\u0000${name.toLowerCase()}`
  /** Every owner name in the file that matches nobody here, once each. A portal
   *  carries the names of people who never got a Rawr account, and at eighty-eight
   *  thousand rows that used to be eighty-eight thousand identical errors. */
  const unmatchedOwners = new Set<string>()

  const lookUp = async (field: RegistryField, names: string[]): Promise<void> => {
    const lookup = RELATION_LOOKUPS[field.key]
    const fresh = [...new Set(names.map((name) => name.trim().toLowerCase()))].filter(
      (name) => name && !isUuid(name) && !remembered.has(keyOf(field, name)),
    )
    if (!lookup || fresh.length === 0) return
    const list = sql`(select jsonb_array_elements_text(${JSON.stringify(fresh)}::jsonb))`
    const rows = await withAccount(ctx, (tx) =>
      tx.execute<{ id: string; a: string | null; b: string | null }>(lookup.find(list)),
    )
    const found = new Map<string, string>()
    for (const row of rows) {
      for (const name of [row.a, row.b]) if (name && !found.has(name)) found.set(name, row.id)
    }
    for (const name of fresh) remembered.set(keyOf(field, name), found.get(name) ?? null)
  }

  const resolve = async (field: RegistryField, raw: string): Promise<string | null> => {
    const needle = raw.trim()
    if (isUuid(needle)) return needle
    const lookup = RELATION_LOOKUPS[field.key]
    if (!lookup) throw new ValueError(field, 'has to be picked from the list, not typed.')

    await lookUp(field, [needle])
    let id = remembered.get(keyOf(field, needle)) ?? null
    if (id === null && field.key === 'company_id') {
      if (!options.create) return null
      try {
        const created = await createRecord(ctx, 'company', DOMAIN.test(needle) ? { name: needle, domain: needle.toLowerCase() } : { name: needle }, NO_ENRICH)
        id = created.id
      } catch (cause) {
        if (!(cause instanceof DuplicateError)) throw cause
        id = cause.existingId
      }
      remembered.set(keyOf(field, needle), id)
    }
    if (id === null) {
      // An owner who is not here is a person, not a mistake in the file. The row
      // lands unassigned and the name is reported once, so somebody can invite
      // them and re-run; every other relation is still a refusal, because a stage
      // or a pipeline that does not exist means the column is mapped wrong.
      if (field.key === 'owner_id') {
        unmatchedOwners.add(needle)
        return null
      }
      throw new ValueError(field, `no ${lookup.what} called "${needle}" exists in this account.`)
    }
    return id
  }

  /** Every relation these rows name, asked for up front, one query per field. */
  const prime = async (object: RegistryObject, mapping: Mapping, rows: ImportRow[]): Promise<void> => {
    for (const [header, target] of Object.entries(mapping)) {
      if (typeof target !== 'string') continue
      const field = object.byKey.get(target)
      if (!field || (field.type !== 'relation' && field.type !== 'user')) continue
      await lookUp(field, rows.flatMap((row) => row[header] ?? []))
    }
  }

  return Object.assign(resolve, { unmatchedOwners, prime })
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
  const dedupeKey = dedupeKeyOf(kind, object)
  for (const [header, target] of Object.entries(mapping)) {
    if (!target) continue
    // A proposal is skipped rather than resolved: the field does not exist until
    // the run makes it, and until then a preview of that column is a guess about
    // a definition nobody has confirmed.
    const key = isNewProperty(target) ? target.key : target
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
      // A value that does not fit costs that one cell, not the whole record. A
      // contact with sixty-seven good columns and a "-" where a number was
      // guessed from a sample is still that contact, and refusing it threw away
      // the sixty-seven.
      //
      // Three things still refuse the row. The column it is matched on, because
      // without it there is nothing to write to. A field somebody marked
      // required, because they said so. And anything that is not a value
      // complaint at all, which is a fault rather than a bad cell.
      //
      // Only for a record file. Every other kind is one instruction per row —
      // put this deal on that company — where a dropped cell leaves half an
      // instruction, and half is worse than none.
      const essential = key === dedupeKey || field.isRequired || kind !== 'records'
      if (essential || !(cause instanceof ValueError)) {
        return {
          values,
          warnings,
          error: cause instanceof ValueError ? cause.message : String(cause),
        }
      }
      warnings.push(`${cause.message} Left empty, and the rest of the row imported.`)
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

/** The column a core record is matched on, the same one `dedupeKeyOf` makes the
 *  mapper insist on. A deal has no unique key, so its name is the match: without
 *  it the mapper's promise that a second run updates was false for every deal. */
const CORE_MATCH: Record<string, string> = { contact: 'email', company: 'domain', deal: 'name' }

/** What makes two rows of one file the same record. The run creates the first and
 *  updates the rest, so the preview has to count the rest as updates too. */
const dedupeIdentity = (object: RegistryObject, values: Record<string, unknown>): string | null => {
  const key = object.isCustom ? object.labelFieldKey : (CORE_MATCH[object.key] ?? null)
  const value = key ? values[key] : null
  if (!key || typeof value !== 'string' || !value) return null
  return `${key}:${key === 'domain' ? value : value.toLowerCase()}`
}

const dedupeLookup = async (
  ctx: AccountContext,
  object: RegistryObject,
  values: Record<string, unknown>,
): Promise<string | null> => {
  if (object.isCustom) {
    const labelKey = object.labelFieldKey
    const named = labelKey ? values[labelKey] : null
    if (!labelKey || typeof named !== 'string' || !named) return null
    assertUsableFieldKey(labelKey)
    return withAccount(ctx, async (tx) => {
      const [found] = await tx.execute<{ id: string }>(
        sql`select id from custom_record
             where object_id = ${object.id}::uuid and deleted_at is null
               and lower(custom ->> ${labelKey}) = lower(${named}) limit 1`,
      )
      return found?.id ?? null
    })
  }
  const key = CORE_MATCH[object.key]
  const value = key ? values[key] : null
  if (!key || typeof value !== 'string' || !value) return null

  return withAccount(ctx, async (tx) => {
    const [found] = await tx.execute<{ id: string }>(
      key === 'email'
        ? sql`select id from contact where lower(email) = lower(${value}) and deleted_at is null limit 1`
        : key === 'domain'
          ? sql`select id from company where domain = ${value} and deleted_at is null limit 1`
          : sql`select id from deal where lower(name) = lower(${value}) and deleted_at is null
                 order by created_at limit 1`,
    )
    return found?.id ?? null
  })
}

/** Which of these rows already name a record, by the same identity the run
 *  matches on, in one query for all of them, and which record each one is.
 *
 *  The id rather than a bare yes is what lets the run update without asking again
 *  per row: `dedupeLookup` is a transaction and a query each, so two hundred of
 *  them are a thousand round trips before a single record is written. */
const knownIdentities = async (
  ctx: AccountContext,
  object: RegistryObject,
  rows: Record<string, unknown>[],
): Promise<Map<string, string>> => {
  const key = object.isCustom ? object.labelFieldKey : CORE_MATCH[object.key]
  const identities = new Set(rows.flatMap((values) => dedupeIdentity(object, values) ?? []))
  if (!key || identities.size === 0) return new Map()
  const wanted = [...identities].map((identity) => identity.slice(key.length + 1))
  const list = sql`(select jsonb_array_elements_text(${JSON.stringify(wanted)}::jsonb))`
  if (object.isCustom) assertUsableFieldKey(key)
  const found = await withAccount(ctx, (tx) =>
    tx.execute<{ id: string; value: string }>(
      object.isCustom
        ? sql`select id, lower(custom ->> ${key}) as value from custom_record
               where object_id = ${object.id}::uuid and deleted_at is null and lower(custom ->> ${key}) in ${list}`
        : key === 'email'
          ? sql`select id, lower(email) as value from contact where deleted_at is null and lower(email) in ${list}`
          : key === 'domain'
            ? sql`select id, domain as value from company where deleted_at is null and domain in ${list}`
            : sql`select distinct on (lower(name)) id, lower(name) as value from deal
                   where deleted_at is null and lower(name) in ${list}
                   order by lower(name), created_at`,
    ),
  )
  return new Map(found.map((row) => [`${key}:${row.value}`, row.id]))
}

/** Every kind but `records` is mapped against a fixed shape rather than the
 *  account's registry: nothing on those rows becomes a column on a record, they
 *  say which record something belongs to and what it was. */
/** Exported because the mapper screen needs the same answer this file does. It
 *  used to ask the registry for whatever `object_type` said, which for a shape
 *  file is "contact", so every column offered contact fields, none of them
 *  matched what was actually mapped, and the whole file read as "Do not import"
 *  over a mapping that was correct in the database. */
export const importShapeFor = (kind: ImportKind): RegistryObject | null =>
  ({
    activities: ACTIVITY_IMPORT,
    properties: PROPERTY_IMPORT,
    associations: ASSOCIATION_IMPORT,
    lists: LIST_IMPORT,
    submissions: SUBMISSION_IMPORT,
  })[kind as string] ?? null

const objectFor = async (
  ctx: AccountContext,
  kind: ImportKind,
  objectKey: string,
): Promise<RegistryObject> =>
  importShapeFor(kind) ?? objectOrThrow(await getRegistry(ctx), objectKey)

const SHAPE_OF: Partial<Record<ImportKind, string>> = {
  properties: 'property',
  associations: 'association',
  lists: 'list',
  submissions: 'submission',
}

/** The header preset a file gets opened with. Named sources win; a file nobody
 *  labelled is still recognised when it carries HubSpot's own columns. */
const presetFor = (
  kind: ImportKind,
  objectKey: string,
  source: string | null,
  headers: string[],
): Record<string, string | null> => {
  // The four B9 shapes are recognised by the kind the person picked, not by the
  // file: a two-column list export carries none of HubSpot's tells, and refusing
  // to preset it because of that would be a guess in the wrong direction.
  const shape = SHAPE_OF[kind]
  if (shape) return hubspotShapePreset(shape, headers)
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
const recordResolver = (ctx: AccountContext) => {
  const remembered = new Map<string, { type: 'contact' | 'company'; id: string } | null>()
  return async (values: Record<string, unknown>) => {
    const email = typeof values.contact_email === 'string' ? values.contact_email.toLowerCase() : ''
    const domain = typeof values.company_domain === 'string' ? values.company_domain.toLowerCase() : ''
    const cacheKey = `${email}\u0000${domain}`
    const found = remembered.get(cacheKey)
    if (found !== undefined) return found

    const resolved = await withAccount(ctx, async (tx) => {
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
  /** How many rows were actually put through the mapper, out of how many the file
   *  has. Everything past `checked` is counted as a create, which is what a row
   *  nobody has seen usually is; saying so is the difference between a count and
   *  a claim. */
  checked: number
  total: number
  /** Columns with nowhere to go that the run will make a property for, and what
   *  each would be. Nothing here is created until the run starts. */
  newProperties: { header: string; label: string; type: FieldType; options?: string[] }[]
  /** Choices the file uses that a field does not have yet. They are added when
   *  the run starts, which is why rows using them count as imported here. */
  newChoices: { label: string; choices: string[] }[]
  samples: { create: ImportRow[]; update: ImportRow[]; error: RowError[] }
}

/** The choice columns of a run, read against the whole file. */
type Settled = {
  object: RegistryObject
  mapping: Mapping
  added: { field: RegistryField; choices: string[] }[]
}

/** The parts of a list cell: "a; b;c" is three choices. */
const splitList = (value: string): string[] =>
  value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)

/** More distinct cells than this and the column is a name or an id, not a set of
 *  choices, so the scan stops rather than reading every one of them. */
const CHOICE_SCAN = 5_000

/** Every distinct value each of these columns holds across the whole file, not
 *  the rows the mapper sampled: a choice that first appears on row 40,000 is still
 *  a choice. One query for every column, O(cells); a column stops at CHOICE_SCAN
 *  values, and `complete` says whether it got there. */
const fileValues = async (
  ctx: AccountContext,
  id: string,
  headers: string[],
): Promise<Map<string, { values: string[]; complete: boolean }>> => {
  const found = new Map(headers.map((header) => [header, { values: [] as string[], complete: true }]))
  if (headers.length === 0) return found
  const rows = await withAccount(ctx, (tx) =>
    tx.execute<{ header: string; value: string }>(sql`
      select header, value from (
        select header, value, row_number() over (partition by header order by value) as n from (
          select distinct cell.key as header, btrim(cell.value) as value
            from import_row r cross join jsonb_each_text(r.values) as cell
           where r.run_id = ${id}::uuid
             and cell.key in (select jsonb_array_elements_text(${JSON.stringify(headers)}::jsonb))
             and btrim(cell.value) <> ''
        ) as distinct_cells
      ) as ranked
      where n <= ${CHOICE_SCAN}`),
  )
  for (const { header, value } of rows) found.get(header)?.values.push(value)
  for (const entry of found.values()) entry.complete = entry.values.length < CHOICE_SCAN
  return found
}

/** A column's values as choices: a list cell counts as each of its parts, and a
 *  choice spelled two ways in the file counts once. */
const choicesIn = (found: { values: string[]; complete: boolean } | undefined, list: boolean) => {
  const seen = new Map<string, string>()
  for (const value of found?.values ?? []) {
    for (const part of list ? splitList(value) : [value]) {
      if (!seen.has(part.toLowerCase())) seen.set(part.toLowerCase(), part)
    }
  }
  return { choices: [...seen.values()], complete: found?.complete ?? true }
}

const fitsAField = (found: { choices: string[]; complete: boolean }): boolean =>
  found.complete &&
  found.choices.length > 0 &&
  found.choices.length <= MAX_CHOICES &&
  found.choices.every((choice) => choice.length <= MAX_OPTION_LENGTH)

/** A proposed choice field takes every choice the file uses, or becomes text when
 *  that is more than a field can hold. An existing one gains the choices it is
 *  missing, so a portal's own lead statuses arrive instead of every row that uses
 *  one being refused. Only record files: the other kinds map onto fixed shapes
 *  whose choices are the importer's, not the account's. */
const settleChoices = async (
  ctx: AccountContext,
  id: string,
  object: RegistryObject,
  mapping: Mapping,
): Promise<Settled> => {
  const next: Mapping = { ...mapping }
  const fields = new Map(object.fields.map((field) => [field.key, field]))
  const added: Settled['added'] = []
  const isChoice = (type: FieldType) => type === 'select' || type === 'multi_select'
  const choiceColumns = Object.entries(mapping).flatMap(([header, target]) => {
    if (!target) return []
    if (isNewProperty(target)) return isChoice(target.type) ? [header] : []
    const field = fields.get(target)
    return field && isChoice(field.type) && field.options.length > 0 ? [header] : []
  })
  const values = await fileValues(ctx, id, choiceColumns)

  for (const header of choiceColumns) {
    const target = mapping[header]!
    if (isNewProperty(target)) {
      const found = choicesIn(values.get(header), target.type === 'multi_select')
      next[header] = fitsAField(found)
        ? { ...target, options: found.choices.sort() }
        : { ...target, type: 'text', options: undefined }
      continue
    }
    const field = fields.get(target)!
    const found = choicesIn(values.get(header), field.type === 'multi_select')
    const missing = found.choices.filter((choice) => choiceOf(field.options, choice) === undefined)
    const options = [...field.options, ...missing]
    // Past the limit the column is mapped wrong, and its rows are refused with
    // the field's own choices named, which says so better than a field of 900.
    if (missing.length === 0 || !fitsAField({ choices: options, complete: found.complete })) continue
    fields.set(field.key, { ...field, options })
    added.push({ field, choices: missing })
  }
  return { object: { ...object, fields: [...fields.values()], byKey: fields }, mapping: next, added }
}

const SAMPLE_SIZE = 5
const PREVIEW_ROWS = 500

/** Counts over the whole file, worked examples over the first few hundred rows.
 *  Checking every row against the database before the run would double the work of
 *  the import for a number the person is about to confirm anyway. */
export const dryRun = async (
  ctx: AccountContext,
  input: { objectKey: string; mapping: Mapping; rows: ImportRow[]; kind?: ImportKind; source?: string | null },
): Promise<DryRun> => preview(ctx, { ...input, rows: input.rows.slice(0, PREVIEW_ROWS), total: input.rows.length })

/** The preview itself, over rows the caller has already narrowed to the window it
 *  wants checked. `total` is the file's length, which is what the extrapolation
 *  and the honesty about coverage are both written from. */
const preview = async (
  ctx: AccountContext,
  input: {
    objectKey: string
    mapping: Mapping
    rows: ImportRow[]
    total: number
    kind?: ImportKind
    source?: string | null
    /** The whole file's choices, when the rows live on a run to read them from. */
    settled?: Settled
  },
): Promise<DryRun> => {
  const kind = input.kind ?? 'records'
  const object = input.settled?.object ?? (await objectFor(ctx, kind, input.objectKey))
  const mapping = input.settled?.mapping ?? input.mapping
  assertMappingIsUsable(object, mapping, kind)

  const result: DryRun = {
    willCreate: 0,
    willUpdate: 0,
    willSkip: 0,
    willError: 0,
    checked: input.rows.length,
    total: input.total,
    newProperties: Object.entries(mapping).flatMap(([header, target]) =>
      isNewProperty(target) && !object.byKey.has(target.key)
        ? [{ header, label: target.label, type: target.type, ...(target.options ? { options: target.options } : {}) }]
        : [],
    ),
    newChoices: (input.settled?.added ?? []).map(({ field, choices }) => ({ label: field.label, choices })),
    samples: { create: [], update: [], error: [] },
  }

  const checked = input.rows
  // Records this file will have created by the time a later row with the same
  // identity is reached, so a repeat inside the file counts as the update it is.
  const willExist = new Set<string>()
  const resolve = relationResolver(ctx, { create: false })
  const findRecord = recordResolver(ctx)
  const writer = SHAPE_WRITER[kind]
  const deps: ShapeDeps = { ctx, source: input.source ?? null, dry: true, cache: new Map() }
  await resolve.prime(object, mapping, checked)
  const plans = []
  for (const row of checked) plans.push(await planRow(object, mapping, row, resolve, kind))
  // One lookup for the whole window rather than one per row. Each is a round trip
  // to the database, and five hundred of them made a preview take minutes.
  const known =
    writer || kind === 'activities'
      ? new Map<string, string>()
      : await knownIdentities(ctx, object, plans.flatMap((plan) => (plan.error ? [] : [plan.values])))
  for (const [index, row] of checked.entries()) {
    const planned = plans[index]!
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
    // The four B9 shapes resolve exactly as the run will and write nothing, so the
    // preview cannot promise one thing and the run do another.
    if (writer) {
      const outcome = await writer(deps, planned.values)
      if (typeof outcome === 'object') {
        result.willError += 1
        if (result.samples.error.length < SAMPLE_SIZE) {
          result.samples.error.push({ row: index + 2, reason: outcome.error, values: row })
        }
      } else if (outcome === 'skipped') {
        result.willSkip += 1
      } else {
        if (outcome === 'updated') result.willUpdate += 1
        else result.willCreate += 1
        const bucket = outcome === 'updated' ? result.samples.update : result.samples.create
        if (bucket.length < SAMPLE_SIZE) bucket.push(row)
      }
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
            reason: 'No contact or company in this account matches that address, so there is nothing to put this on.',
            values: row,
          })
        }
      }
      continue
    }
    const identity = dedupeIdentity(object, planned.values)
    if (identity && (willExist.has(identity) || known.has(identity))) {
      result.willUpdate += 1
      if (result.samples.update.length < SAMPLE_SIZE) result.samples.update.push(row)
    } else {
      result.willCreate += 1
      if (identity) willExist.add(identity)
      if (result.samples.create.length < SAMPLE_SIZE) result.samples.create.push(row)
    }
  }

  // Rows beyond the sampled window are reported as creates rather than left out of
  // the totals, and the run itself still updates whatever already exists.
  const remaining = input.total - checked.length
  if (remaining > 0) result.willCreate += remaining
  return result
}

/** The preview a person clicks for, read from the run rather than posted back up.
 *
 *  It used to travel as a GET query string carrying up to 500 rows of somebody's
 *  file, which is a URL no browser or proxy will accept and the reason preview
 *  answered "Failed to fetch". The rows are already on the server; only the id
 *  has to make the trip. */
export const previewImportRun = async (ctx: AccountContext, id: string): Promise<DryRun> => {
  assertCanWrite(ctx, 'import_run')
  if (!isUuid(id)) throw new Error('That import no longer exists.')

  const [run] = await withAccount(ctx, (tx) =>
    tx
      .select({
        objectType: importRun.objectType,
        importKind: importRun.importKind,
        source: importRun.source,
        mapping: importRun.mapping,
        totalRows: importRun.totalRows,
        state: importRun.state,
      })
      .from(importRun)
      .where(eq(importRun.id, id))
      .limit(1),
  )
  if (!run) throw new Error('That import no longer exists.')
  if (run.state === 'uploading') throw new Error(STILL_ARRIVING)
  if (run.state !== 'mapping' && run.state !== 'previewing') {
    throw new Error('That import has already been started, so there is nothing left to preview.')
  }

  // Re-enterable from either state, and left in neither: a preview writes nothing,
  // so a run whose preview was interrupted is back where it was rather than stuck
  // in 'previewing' with no way out.
  await withAccount(ctx, (tx) =>
    tx.update(importRun).set({ state: 'previewing', updatedAt: new Date() }).where(eq(importRun.id, id)),
  )
  try {
    const mapping = run.mapping as Mapping
    return await preview(ctx, {
      objectKey: run.objectType,
      kind: run.importKind,
      source: run.source,
      mapping,
      rows: await readImportRows(ctx, id, 0, PREVIEW_ROWS),
      total: run.totalRows,
      ...(run.importKind === 'records'
        ? { settled: await settleChoices(ctx, id, await objectFor(ctx, run.importKind, run.objectType), mapping) }
        : {}),
    })
  } finally {
    await withAccount(ctx, (tx) =>
      tx.update(importRun).set({ state: 'mapping', updatedAt: new Date() }).where(eq(importRun.id, id)),
    ).catch(() => {
      // The preview is the answer; failing to put the state back must not replace
      // it with an error about bookkeeping.
    })
  }
}

/** A window of the file, by position. The primary key is (run_id, position), so
 *  this is an index range scan whatever the file's length. */
export const readImportRows = async (
  ctx: AccountContext,
  id: string,
  from: number,
  count: number,
): Promise<ImportRow[]> => {
  if (!isUuid(id) || count <= 0) return []
  const rows = await withAccount(ctx, (tx) =>
    tx
      .select({ values: importRow.values })
      .from(importRow)
      .where(
        and(
          eq(importRow.runId, id),
          gte(importRow.position, from),
          lt(importRow.position, from + count),
        ),
      )
      .orderBy(asc(importRow.position)),
  )
  return rows.map((row) => row.values as ImportRow)
}

/** One multi-row insert per batch: 88,000 rows cost 88 statements, not 88,000
 *  round trips. Batched rather than sent whole because a single statement binds
 *  four parameters per row and Postgres takes 65,535 of them. */
const ROWS_PER_INSERT = 1000

/** A row as stored: its cells by header, trimmed, the empty ones left out. */
const storedRow = (row: ImportRow): ImportRow =>
  Object.fromEntries(
    Object.entries(row).flatMap(([header, value]) => {
      const text = String(value ?? '').trim()
      return text ? [[header, text]] : []
    }),
  )

const writeImportRows = async (
  tx: Tx,
  accountId: string,
  runId: string,
  from: number,
  rows: ImportRow[],
): Promise<void> => {
  for (let offset = 0; offset < rows.length; offset += ROWS_PER_INSERT) {
    await tx.insert(importRow).values(
      rows.slice(offset, offset + ROWS_PER_INSERT).map((values, index) => ({
        accountId,
        runId,
        position: from + offset + index,
        values: storedRow(values),
      })),
    )
  }
}

/** A run that is over keeps only the rows it refused, which are its error file.
 *  The rest existed to make a killed run resumable, and an ended run is not. */
const dropImportRows = async (ctx: AccountContext, id: string): Promise<void> => {
  await withAccount(ctx, (tx) => tx.delete(importRow).where(and(eq(importRow.runId, id), isNull(importRow.reason))))
}

/** How many rows of the file are looked at to decide what a column holds. Enough
 *  that "twelve distinct values" means something, few enough that the guess costs
 *  a pass over a slice rather than over ninety thousand rows. */
const TYPE_SAMPLE_ROWS = 200

/** A tracking parameter is text whatever it looks like. utm_source has four
 *  values today and forty next quarter, and a select would refuse the other
 *  thirty-six at the point somebody most needs them recorded. */
const UTM_COLUMN = /^utm[_ -]/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]|$)/
/** Above this a column is a name, an id or a note, not a set of choices. */
const MAX_INFERRED_OPTIONS = 12

const inferType = (label: string, values: string[]): { type: FieldType; options?: string[] } => {
  if (values.length === 0 || UTM_COLUMN.test(label)) return { type: 'text' }
  if (values.every((value) => Number.isFinite(Number(value)))) return { type: 'number' }
  if (values.every((value) => ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)))) {
    return { type: 'date' }
  }
  // Several choices in one cell is how HubSpot writes a multiple checkbox.
  const listed = values.some((value) => value.includes(';'))
  const choices = listed ? values.flatMap(splitList) : values
  const distinct = [...new Set(choices)]
  // Fewer distinct values than cells, or every cell is its own value and the
  // column is a name rather than a choice. A value longer than a choice may be is
  // a sentence, and proposing it as one is a field nobody can save.
  if (
    distinct.length <= MAX_INFERRED_OPTIONS &&
    distinct.length < choices.length &&
    distinct.every((choice) => choice.length <= MAX_OPTION_LENGTH)
  ) {
    return { type: listed ? 'multi_select' : 'select', options: distinct.sort() }
  }
  return { type: 'text' }
}

/** The property a column with nowhere to go would become. Null when the header
 *  yields no usable key, which is a column that can only be ignored. */
export const proposeProperty = (header: string, samples: string[]): NewProperty | null => {
  const label = header.trim()
  const key = keyFromLabel(label)
  if (!key) return null
  const values = samples.map((value) => String(value ?? '').trim()).filter(Boolean)
  const { type, options } = inferType(label, values)
  return { create: true, key, label, type, ...(options ? { options } : {}) }
}

/** Every unmapped column turned into a property to create, unless its key is one
 *  the object already has, in which case the column is mapped to it. Only for
 *  record files: the other five kinds are read against a fixed shape, and a
 *  column that shape has no place for is a column with no meaning. */
const withProposals = (
  object: RegistryObject,
  mapping: Mapping,
  rows: ImportRow[],
  kind: ImportKind,
  preset: Record<string, string | null>,
): Mapping => {
  if (kind !== 'records') return mapping
  const samples = rows.slice(0, TYPE_SAMPLE_ROWS)
  const taken = new Set(
    Object.values(mapping).map((target) => (isNewProperty(target) ? target.key : target)).filter(Boolean) as string[],
  )
  const next: Mapping = { ...mapping }
  for (const [header, target] of Object.entries(mapping)) {
    if (target) continue
    // Unmapped on purpose, not for want of a field: a column the export's preset
    // dismisses, or one naming a field Rawr keeps up to date itself.
    if (header in preset || fieldNamed(object.fields, header)) continue
    const proposal = proposeProperty(header, samples.map((row) => row[header] ?? ''))
    if (!proposal || taken.has(proposal.key)) continue
    const existing = object.byKey.get(proposal.key)
    if (existing && !isImportable(existing)) continue
    // A key the object already has is a column that was only unmapped because the
    // header did not read like the label. Mapping to it beats a second field
    // holding the same thing under a name one character different.
    next[header] = existing ? proposal.key : proposal
    taken.add(proposal.key)
  }
  return next
}

/** The proposals a run still has to make, once and in one transaction, under the
 *  group the migration puts everything it invented. Idempotent: a key that exists
 *  by the time this runs is mapped rather than created, which is what makes a
 *  second run of the same file create nothing. */
const IMPORTED_GROUP = 'Imported from HubSpot'

export const createProposedProperties = async (
  ctx: AccountContext,
  id: string,
): Promise<{ created: number }> => {
  const [run] = await withAccount(ctx, (tx) =>
    tx
      .select({ objectType: importRun.objectType, importKind: importRun.importKind, mapping: importRun.mapping })
      .from(importRun)
      .where(eq(importRun.id, id))
      .limit(1),
  )
  if (!run) throw new Error('That import no longer exists.')

  const mapping = run.mapping as Mapping
  const proposals = Object.entries(mapping).flatMap(([header, target]) =>
    isNewProperty(target) ? [[header, target] as const] : [],
  )
  if (proposals.length === 0) return { created: 0 }

  const { created } = await createFields(
    ctx,
    proposals.map(([, proposal]) => ({
      objectKey: run.objectType,
      key: proposal.key,
      label: proposal.label,
      type: proposal.type,
      ...(proposal.options ? { options: proposal.options } : {}),
      groupName: IMPORTED_GROUP,
      source: 'import',
    })),
  )

  // The mapping stops carrying proposals the moment the fields exist, so every
  // chunk after this reads plain keys and starting the run twice creates nothing.
  const settled: Mapping = { ...mapping }
  for (const [header, proposal] of proposals) settled[header] = proposal.key
  await withAccount(ctx, (tx) =>
    tx.update(importRun).set({ mapping: settled, updatedAt: new Date() }).where(eq(importRun.id, id)),
  )

  return { created: created.length }
}

const STILL_ARRIVING = 'That file is still arriving. Wait for the upload to finish, or upload it again.'

/** Blank names would collide in the mapping, and duplicates would silently drop a
 *  column, so both are made unique and visible rather than fixed up quietly. */
const nameHeaders = (raw: string[]): string[] => {
  const seen = new Map<string, number>()
  return raw.map((header, index) => {
    const base = header.trim() || `Column ${index + 1}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base} (${count + 1})`
  })
}

/** The first of three steps: the run, named and shaped, with none of its rows.
 *  The rows follow in batches and `finishImportRun` opens the mapper. Nothing
 *  reads a run that is still 'uploading', so a file that never finishes arriving
 *  is never half imported. */
export const beginImportRun = async (
  ctx: AccountContext,
  input: {
    objectKey: string
    filename: string
    headers: string[]
    kind?: ImportKind
    source?: string | null
    /** Left empty, the mapping is worked out when the last row has arrived. */
    mapping?: Mapping
  },
): Promise<{ id: string }> => {
  assertCanWrite(ctx, input.objectKey)
  const kind = input.kind ?? 'records'
  const object = await objectFor(ctx, kind, input.objectKey)
  const headers = nameHeaders(input.headers)
  if (headers.length === 0) throw new Error('That file has no columns in it.')

  const [row] = await withAccount(ctx, (tx) =>
    tx
      .insert(importRun)
      .values({
        accountId: ctx.accountId,
        // A shape file is matched against contacts whatever it names; a record
        // file carries its own object, which since 0066 may be an invented one.
        objectType: kind === 'activities' ? 'contact' : object.key,
        importKind: kind,
        source: input.source ?? null,
        filename: input.filename,
        fileSignature: fileSignature(`${kind}:${object.key}`, headers),
        headers,
        mapping: input.mapping ?? {},
        state: 'uploading',
        createdBy: ctx.actorId,
      })
      .returning({ id: importRun.id }),
  )
  if (!row) throw new Error('The import could not be started.')
  return { id: row.id }
}

/** One batch of the file, cells in the order of the run's headers. `from` is the
 *  position of its first row, which is what makes a batch sent twice, after an
 *  answer that never arrived, land once. */
export const appendImportRows = async (
  ctx: AccountContext,
  id: string,
  input: { from: number; rows: string[][] },
): Promise<{ total: number }> => {
  assertCanWrite(ctx, 'import_run')
  if (!isUuid(id)) throw new Error('That import no longer exists.')
  return withAccount(ctx, async (tx) => {
    // Locked, so two copies of one batch cannot both find the position free.
    const [run] = await tx
      .select({ state: importRun.state, headers: importRun.headers, totalRows: importRun.totalRows })
      .from(importRun)
      .where(eq(importRun.id, id))
      .for('update')
    if (!run) throw new Error('That import no longer exists.')
    if (run.state !== 'uploading') throw new Error('That file has finished arriving, so nothing more can be added to it.')
    if (input.from + input.rows.length <= run.totalRows) return { total: run.totalRows }
    if (input.from !== run.totalRows) throw new Error('The upload lost its place in the file. Upload it again.')

    const headers = run.headers as string[]
    await writeImportRows(
      tx,
      ctx.accountId,
      id,
      input.from,
      input.rows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']))),
    )
    const total = input.from + input.rows.length
    await tx.update(importRun).set({ totalRows: total, updatedAt: new Date() }).where(eq(importRun.id, id))
    return { total }
  })
}

/** The last row has arrived: the mapping is worked out from the file and the run
 *  opens in the mapper. */
export const finishImportRun = async (
  ctx: AccountContext,
  id: string,
): Promise<{ id: string; suggested: Mapping; previousMapping: Mapping | null }> => {
  assertCanWrite(ctx, 'import_run')
  if (!isUuid(id)) throw new Error('That import no longer exists.')
  const [run] = await withAccount(ctx, (tx) =>
    tx
      .select({
        objectType: importRun.objectType,
        importKind: importRun.importKind,
        source: importRun.source,
        filename: importRun.filename,
        fileSignature: importRun.fileSignature,
        headers: importRun.headers,
        mapping: importRun.mapping,
        totalRows: importRun.totalRows,
        state: importRun.state,
      })
      .from(importRun)
      .where(eq(importRun.id, id))
      .limit(1),
  )
  if (!run) throw new Error('That import no longer exists.')
  // Asked twice when the first answer never reached the browser. The run is
  // already in the mapper, and saying so beats an error that cancels it.
  if (run.state === 'mapping') return { id, suggested: run.mapping as Mapping, previousMapping: null }
  if (run.state !== 'uploading') throw new Error('That upload was stopped. Upload the file again.')
  if (run.totalRows === 0) throw new Error('That file has a header row and nothing under it.')

  const kind = run.importKind
  const object = await objectFor(ctx, kind, run.objectType)
  const headers = run.headers as string[]
  const preset = presetFor(kind, object.key, run.source, headers)
  const suggested = withProposals(
    object,
    suggestMapping(object, headers, preset),
    await readImportRows(ctx, id, 0, TYPE_SAMPLE_ROWS),
    kind,
    preset,
  )
  const given = run.mapping as Mapping

  return mutate(ctx, 'import_run', async (tx) => {
    const [previous] = await tx
      .select({ mapping: importRun.mapping })
      .from(importRun)
      .where(and(eq(importRun.fileSignature, run.fileSignature), eq(importRun.state, 'done')))
      .orderBy(desc(importRun.createdAt))
      .limit(1)
    await tx
      .update(importRun)
      .set({ mapping: Object.keys(given).length > 0 ? given : suggested, state: 'mapping', updatedAt: new Date() })
      .where(and(eq(importRun.id, id), eq(importRun.state, 'uploading')))
    return {
      result: { id, suggested, previousMapping: (previous?.mapping as Mapping | undefined) ?? null },
      audit: {
        entity: 'import_run',
        entityId: id,
        action: 'create',
        before: null,
        after: { filename: run.filename, rows: run.totalRows, kind, source: run.source },
      },
    }
  })
}

/** A whole file in one call, for a caller that already holds its rows: scripts
 *  and the verify suites. The browser takes the same three steps a batch at a
 *  time. An empty mapping means "work it out": the caller has no view of the
 *  preset, and re-deriving it in two places is how the two drift. */
export const createImportRun = async (
  ctx: AccountContext,
  input: {
    objectKey: string
    filename: string
    headers: string[]
    rows: ImportRow[]
    mapping: Mapping
    kind?: ImportKind
    source?: string | null
  },
): Promise<{ id: string; suggested: Mapping; previousMapping: Mapping | null }> => {
  const { id } = await beginImportRun(ctx, input)
  if (input.rows.length > 0) {
    await appendImportRows(ctx, id, {
      from: 0,
      rows: input.rows.map((row) => input.headers.map((header) => row[header] ?? '')),
    })
  }
  return finishImportRun(ctx, id)
}

export const setImportMapping = async (
  ctx: AccountContext,
  id: string,
  mapping: Mapping,
): Promise<void> =>
  mutate(ctx, 'import_run', async (tx) => {
    const [run] = await tx
      .select({ objectType: importRun.objectType, importKind: importRun.importKind, state: importRun.state })
      .from(importRun)
      .where(eq(importRun.id, id))
    if (!run) throw new Error('That import no longer exists.')
    if (run.state === 'uploading') throw new Error(STILL_ARRIVING)
    // A started run reads its mapping chunk by chunk, so changing it now would
    // import the top of the file one way and the rest another.
    if (run.state !== 'mapping' && run.state !== 'previewing') {
      throw new Error('That import has already been started, so its mapping can no longer change.')
    }
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
  ctx: AccountContext,
  findRecord: ReturnType<typeof recordResolver>,
  source: string | null,
  values: Record<string, unknown>,
): Promise<'created' | 'already' | 'unmatched'> => {
  const target = await findRecord(values)
  if (!target) return 'unmatched'

  const occurredAt = values.occurred_at instanceof Date ? values.occurred_at : new Date()
  const type = ACTIVITY_KIND[String(values.activity_type ?? 'note')] ?? 'note'
  const key = importKeyOf(source, values)

  return withAccount(ctx, async (tx) => {
    // Written as SQL rather than through the query builder because the unique
    // index is partial, and Postgres only infers a partial index for ON CONFLICT
    // when the same predicate is repeated here. The index stays partial so it
    // covers imported rows rather than every activity ever written.
    const [row] = await tx.execute<{ id: string }>(sql`
      insert into activity (account_id, type, subject, body, occurred_at, actor_id, actor_kind, source, import_key)
      values (${ctx.accountId}::uuid, ${type}::rawr_activity_type,
              ${typeof values.subject === 'string' ? values.subject : null},
              ${typeof values.body === 'string' ? values.body : null},
              ${occurredAt.toISOString()}::timestamptz,
              ${ctx.actorId}::uuid, ${ctx.actorKind}::rawr_actor_kind,
              ${source ?? 'import'}, ${key})
      on conflict (account_id, import_key) where import_key is not null do nothing
      returning id`)
    if (!row) return 'already'

    // An email with a contact is an email with their company and their deals, the
    // same way a synced one is. Imported history that only reached the contact
    // left every company timeline empty for the years before Rawr existed.
    const links =
      target.type === 'contact'
        ? await linksForContacts(tx, [target.id])
        : [{ entityType: target.type, entityId: target.id }]

    await tx
      .insert(activityLink)
      .values(
        links.map((link) => ({
          accountId: ctx.accountId,
          activityId: row.id,
          entityType: link.entityType,
          entityId: link.entityId,
          type,
          occurredAt,
        })),
      )
      .onConflictDoNothing()
    return 'created'
  })
}

/* -- B9: what the four shape files do with one planned row ----------------- */

/** What happened to one row. The same four answers the records path already
 *  reports, so the counters on `import_run` need no new column. */
type RowOutcome = 'created' | 'updated' | 'skipped' | { error: string }

/** Everything a shape writer needs, threaded once per chunk rather than rebuilt
 *  per row: the lookups are memoised, which is the difference between a file of
 *  forty thousand rows about three hundred things costing three hundred queries
 *  and costing forty thousand. */
type ShapeDeps = {
  ctx: AccountContext
  source: string | null
  /** The preview resolves exactly as the run does and writes nothing, so it
   *  cannot promise one thing and the run do another. */
  dry: boolean
  cache: Map<string, string | null>
}

const textOf = (values: Record<string, unknown>, key: string): string => {
  const value = values[key]
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}

/** One memoised lookup. `make` runs only when nothing matched and the run is real,
 *  so a preview never creates the thing it is previewing. */
const lookupOnce = async (
  deps: ShapeDeps,
  bucket: string,
  needle: string,
  find: SQL,
  make?: () => Promise<string>,
): Promise<string | null> => {
  const cacheKey = `${bucket}\u0000${needle.toLowerCase()}`
  const remembered = deps.cache.get(cacheKey)
  if (remembered !== undefined) return remembered

  const [row] = await withAccount(deps.ctx, (tx) => tx.execute<{ id: string }>(find))
  let id = row?.id ?? null
  if (id === null && make && !deps.dry) id = await make()
  // A dry run remembers nothing it did not find, because the real run will create
  // it and a cached miss would then be handed back after it exists.
  if (id !== null || !make) deps.cache.set(cacheKey, id)
  return id
}

const STARTS_WITH_LETTER = /^[a-z]/

/** A HubSpot property name as a field key, for when the internal-name column was
 *  not mapped. Lowercase and underscores, prefixed when it would otherwise start
 *  with a digit, because the key rule requires a letter first. */
const keyFromLabel = (label: string): string => {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 59)
  if (!base) return ''
  return STARTS_WITH_LETTER.test(base) ? base : `p_${base}`.slice(0, 59)
}

const splitOptions = (raw: string): string[] =>
  raw
    .split(/[;\n|]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 500)

/** One property definition. This is the file that has to land before any record
 *  file does: three hundred and seventy-two columns cannot be imported into fields
 *  that do not exist. */
const writeProperty = async (deps: ShapeDeps, values: Record<string, unknown>): Promise<RowOutcome> => {
  const objectKey = textOf(values, 'object_key').toLowerCase() || 'contact'
  // From the registry, not a list of three: an invented object has properties
  // like any other, and a property file is how a portal's arrive.
  const registry = await getRegistry(deps.ctx)
  if (!registry.byKey.has(objectKey)) {
    return {
      error: `"${objectKey}" is not an object here. Applies to has to be one of: ${registry.objects.map((entry) => entry.key).join(', ')}.`,
    }
  }
  const label = textOf(values, 'label')
  if (!label) return { error: 'A property with no name cannot be created.' }
  const key = (textOf(values, 'key') || keyFromLabel(label)).toLowerCase()
  if (!key) return { error: `"${label}" has no usable internal name, and none could be derived from it.` }

  const type = hubspotFieldType(textOf(values, 'type'), textOf(values, 'field_type'))
  const options = splitOptions(textOf(values, 'options'))
  const helpText = textOf(values, 'help_text') || null
  const groupName = textOf(values, 'group_name') || null

  const [existing] = await withAccount(deps.ctx, (tx) =>
    tx.execute<{ id: string; deleted_at: Date | null; is_custom: boolean }>(sql`
      select f.id, f.deleted_at, f.is_custom
        from field_def f join object_def o on o.id = f.object_id
       where o.key = ${objectKey} and f.key = ${key}
       limit 1`),
  )

  if (existing?.deleted_at) {
    return {
      error: `${objectKey} had a field called "${key}" that was deleted but not purged. Purge it first, or map this row to another name.`,
    }
  }
  if (existing) {
    // A field Rawr ships is not the import's to relabel. "Email" meaning the
    // contact's address is load-bearing in a dozen places, and a portal calling
    // it something else does not change what it is.
    if (!existing.is_custom) return 'skipped'
    if (deps.dry) return 'updated'
    await updateField(deps.ctx, {
      id: existing.id,
      label,
      ...(options.length > 0 ? { options } : {}),
      helpText,
      groupName,
    })
    return 'updated'
  }

  if (deps.dry) return 'created'
  try {
    await createField(deps.ctx, {
      objectKey,
      key,
      label,
      type,
      options,
      helpText,
      groupName,
      source: deps.source ?? 'import',
    })
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
  return 'created'
}

/** A deal's people and companies. A record export carries a contact's primary
 *  company and nothing else, so without this file every imported deal arrives
 *  with nobody on it. */
const writeAssociation = async (deps: ShapeDeps, values: Record<string, unknown>): Promise<RowOutcome> => {
  const dealName = textOf(values, 'deal_name')
  if (!dealName) return { error: 'No deal named, so there is nothing to associate.' }
  const dealId = await lookupOnce(
    deps,
    'deal',
    dealName,
    sql`select id from deal where deleted_at is null and lower(name) = lower(${dealName})
         order by created_at limit 1`,
  )
  if (!dealId) return { error: `No deal called "${dealName}" is here yet. Import the deals first.` }

  const email = textOf(values, 'contact_email').toLowerCase()
  const domain = textOf(values, 'company_domain').toLowerCase()
  const label = textOf(values, 'label') || null

  const targets: { entityType: 'contact' | 'company'; entityId: string }[] = []
  if (email) {
    const contactId = await lookupOnce(
      deps,
      'contact',
      email,
      sql`select id from contact where deleted_at is null and lower(email) = ${email} limit 1`,
    )
    if (!contactId) {
      return { error: `Nobody here has the address ${email}, so there is nothing to put on ${dealName}.` }
    }
    targets.push({ entityType: 'contact', entityId: contactId })
  }
  if (domain) {
    const companyId = await lookupOnce(
      deps,
      'company',
      domain,
      sql`select id from company where deleted_at is null and domain = ${domain} limit 1`,
    )
    if (companyId) targets.push({ entityType: 'company', entityId: companyId })
  }
  if (targets.length === 0) return 'skipped'
  if (deps.dry) return 'created'

  // Written straight rather than through `associate`, which records a timeline
  // entry per link. Eighty-eight thousand of those is a timeline nobody can read
  // and an import nobody can finish.
  let written = 0
  for (const target of targets) {
    const [from, to] = orderedPair({ entityType: 'deal', entityId: dealId }, target)
    const inserted = await withAccount(deps.ctx, (tx) =>
      tx.execute<{ to_id: string }>(sql`
        insert into association (account_id, from_type, from_id, to_type, to_id, label)
        values (${deps.ctx.accountId}, ${from.entityType}, ${from.entityId},
                ${to.entityType}, ${to.entityId}, ${label})
        on conflict (account_id, from_type, from_id, to_type, to_id) do nothing
        returning to_id`),
    )
    written += inserted.length
  }
  return written > 0 ? 'created' : 'skipped'
}

/** One person in one list. The segment is created on first sight and marked
 *  static, because HubSpot's filter language does not translate into Rawr's and a
 *  segment that silently stops matching is worse than one that says it is a
 *  snapshot of the day it arrived. */
const writeListMember = async (deps: ShapeDeps, values: Record<string, unknown>): Promise<RowOutcome> => {
  const listName = textOf(values, 'list_name')
  if (!listName) return { error: 'No list named, so there is nowhere to put this person.' }
  const email = textOf(values, 'contact_email').toLowerCase()
  if (!email) return { error: 'No address, so there is nobody to add.' }

  const contactId = await lookupOnce(
    deps,
    'contact',
    email,
    sql`select id from contact where deleted_at is null and lower(email) = ${email} limit 1`,
  )
  if (!contactId) return { error: `Nobody here has the address ${email}. Import the contacts first.` }

  const segmentId = await lookupOnce(
    deps,
    'segment',
    listName,
    sql`select id from segment where lower(name) = lower(${listName}) limit 1`,
    async () => {
      const [row] = await withAccount(deps.ctx, (tx) =>
        tx.execute<{ id: string }>(sql`
          insert into segment (account_id, name, description, object_id, query, is_static)
          select ${deps.ctx.accountId}, ${listName},
                 ${'Imported list. Its members are the ones the file named, not a query.'},
                 o.id, '[]'::jsonb, true
            from object_def o where o.key = 'contact'
          returning id`),
      )
      if (!row) throw new Error(`The list "${listName}" could not be created.`)
      return row.id
    },
  )
  if (deps.dry) return 'created'
  if (!segmentId) return { error: `The list "${listName}" could not be created.` }

  const written = await withAccount(deps.ctx, (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into segment_membership (account_id, segment_id, entity_id)
      select ${deps.ctx.accountId}, ${segmentId}, ${contactId}
       where not exists (
         select 1 from segment_membership m
          where m.segment_id = ${segmentId} and m.entity_id = ${contactId} and m.exited_at is null)
      returning id`),
  )
  return written.length > 0 ? 'created' : 'skipped'
}

/** Form submission history. The form is created as an inactive shell when it is
 *  not here, because a HubSpot form does not export as a definition: what crosses
 *  is the record of who filled it and when, and a shell that says so is more use
 *  than dropping every row for a form nobody has rebuilt yet. */
const writeSubmission = async (deps: ShapeDeps, values: Record<string, unknown>): Promise<RowOutcome> => {
  const formName = textOf(values, 'form_name')
  if (!formName) return { error: 'No form named, so this submission has nowhere to belong.' }

  const formId = await lookupOnce(
    deps,
    'form',
    formName,
    sql`select id from form where lower(name) = lower(${formName}) limit 1`,
    async () => {
      const stem = keyFromLabel(formName).replace(/_/g, '-') || 'imported'
      const [row] = await withAccount(deps.ctx, (tx) =>
        tx.execute<{ id: string }>(sql`
          insert into form (account_id, name, slug, schema, settings, is_active)
          values (${deps.ctx.accountId}, ${formName},
                  ${stem} || '-' || substr(md5(random()::text), 1, 4),
                  '[]'::jsonb,
                  ${JSON.stringify({ importedFrom: deps.source ?? 'import' })}::jsonb, false)
          returning id`),
      )
      if (!row) throw new Error(`The form "${formName}" could not be created.`)
      return row.id
    },
  )
  if (deps.dry) return 'created'
  if (!formId) return { error: `The form "${formName}" could not be created.` }

  const email = textOf(values, 'contact_email').toLowerCase()
  const contactId = email
    ? await lookupOnce(
        deps,
        'contact',
        email,
        sql`select id from contact where deleted_at is null and lower(email) = ${email} limit 1`,
      )
    : null

  const at = values.submitted_at instanceof Date ? values.submitted_at : new Date()
  const body = textOf(values, 'body')
  const pageUrl = textOf(values, 'page_url')
  // The same partial unique index the Webflow webhook writes through, so a
  // redelivery and a second run of the same export are the same no-op.
  const key = importKeyOf(deps.source, {
    external_id: values.external_id,
    contact_email: email,
    occurred_at: at,
    subject: formName,
    body,
  })

  const written = await withAccount(deps.ctx, (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into form_submission
             (account_id, form_id, values, attribution, contact_id, at, idempotency_key, spam_state)
      values (${deps.ctx.accountId}, ${formId},
              ${JSON.stringify(body ? { imported: body } : {})}::jsonb,
              ${JSON.stringify(pageUrl ? { landing_page: pageUrl } : {})}::jsonb,
              ${contactId}, ${at.toISOString()}::timestamptz, ${key}, 'clean')
      on conflict (account_id, idempotency_key) where idempotency_key is not null do nothing
      returning id`),
  )
  return written.length > 0 ? 'created' : 'skipped'
}

/** One writer per shape. Six kinds branching inside three functions is a chain
 *  nobody can read; a table with an entry each is the same behaviour, scannable.
 *  `records` and `activities` are absent on purpose: the first is the only kind
 *  that goes through the registry, and the second predates this and already has
 *  its own writer. */
const SHAPE_WRITER: Partial<
  Record<ImportKind, (deps: ShapeDeps, values: Record<string, unknown>) => Promise<RowOutcome>>
> = {
  properties: writeProperty,
  associations: writeAssociation,
  lists: writeListMember,
  submissions: writeSubmission,
}

const CHUNK = 5_000
/** Lines of a run's notes kept for the screen, which shows twenty-five. */
const NOTES_KEPT = 100

/** A chunk stops here and answers with what it did, however many of its rows it
 *  got through. The worker waits longer than this for the answer, so a file whose
 *  rows are slow returns short rather than being abandoned mid-write, retried from
 *  the same position, and never finishing. */
const CHUNK_MS = 45_000

/** One chunk of an import. Called repeatedly by the worker, so an interrupted run
 *  continues from processed_rows instead of restarting, and re-running the same
 *  file updates rather than duplicating because the dedupe key drives it. A8. */
export const runImportChunk = async (
  ctx: AccountContext,
  id: string,
): Promise<{ done: boolean; processed: number; total: number }> => {
  assertCanWrite(ctx, 'contact')

  const [run] = await withAccount(ctx, (tx) =>
    tx
      .select({
        objectType: importRun.objectType,
        importKind: importRun.importKind,
        source: importRun.source,
        mapping: importRun.mapping,
        processedRows: importRun.processedRows,
        totalRows: importRun.totalRows,
        state: importRun.state,
        errors: importRun.errors,
        unmatchedOwners: importRun.unmatchedOwners,
      })
      .from(importRun)
      .where(eq(importRun.id, id))
      .limit(1),
  )
  if (!run) throw new Error('That import no longer exists.')
  if (run.state === 'done' || run.state === 'cancelled') {
    return { done: true, processed: run.processedRows, total: run.totalRows }
  }
  if (run.state === 'uploading') throw new Error(STILL_ARRIVING)

  const kind = run.importKind
  const object = await objectFor(ctx, kind, run.objectType).catch(async (cause: unknown) => {
    await failImportRun(ctx, id, cause)
    throw cause
  })
  const mapping = run.mapping as Mapping
  const slice = await readImportRows(ctx, id, run.processedRows, CHUNK)

  let created = 0
  let updated = 0
  let skipped = 0
  // Every row lands in exactly one of the four counts. A warning is said on the
  // side: the row it is about was still written.
  const refused: { position: number; reason: string }[] = []
  const notes: RunNote[] = []
  const refuse = (offset: number, reason: string) => {
    refused.push({ position: run.processedRows + offset, reason })
    notes.push({ row: run.processedRows + offset + 2, reason })
  }
  const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
  const resolve = relationResolver(ctx, { create: true })
  const findRecord = recordResolver(ctx)
  const writer = SHAPE_WRITER[kind]
  const deps: ShapeDeps = { ctx, source: run.source, dry: false, cache: new Map() }
  await resolve.prime(object, mapping, slice)

  // Planned before anything is written, so the chunk's whole dedupe is one query
  // instead of a transaction and a query per row. Planning is where a company
  // named for the first time is created, which is why it stays outside the write
  // transaction below: those companies are wanted whatever becomes of this chunk.
  const plans: Awaited<ReturnType<typeof planRow>>[] = []
  for (const row of slice) plans.push(await planRow(object, mapping, row, resolve, kind))
  const known =
    writer || kind === 'activities'
      ? new Map<string, string>()
      : await knownIdentities(ctx, object, plans.flatMap((plan) => (plan.error ? [] : [plan.values])))

  const deadline = Date.now() + CHUNK_MS
  /** Rows this chunk finished with. Short of the slice when the budget ran out,
   *  and the next chunk starts where this one stopped. */
  let handled = 0

  // A file of records is written for the whole chunk at once: the rules that
  // decide what to write have already run, up there in `planRow`, and what is
  // left is sending it. Every other kind is a row of instructions rather than a
  // record — make this property, put that deal on this company — and each one
  // still goes on its own, below.
  if (!writer && kind !== 'activities') {
    const batch: BulkRow[] = []
    for (const [offset, planned] of plans.entries()) {
      handled = offset + 1
      if (planned.error) {
        refuse(offset, planned.error)
        continue
      }
      if (Object.keys(planned.values).length === 0) {
        skipped += 1
        continue
      }
      for (const warning of planned.warnings) {
        notes.push({ row: run.processedRows + offset + 2, reason: warning, warning: true })
      }
      // Create date is Rawr's to keep, so only a record this row brings into
      // being takes the one the file carries.
      const { created_at: createdAt, ...values } = planned.values
      const identity = dedupeIdentity(object, values)
      batch.push({
        position: offset,
        values,
        existingId: identity ? (known.get(identity) ?? null) : null,
        ...(createdAt instanceof Date ? { createdAt } : {}),
      })
    }

    const outcome = await bulkWriteRecords(ctx, object.key, batch)
    created += outcome.created.length
    updated += outcome.updated.length
    for (const note of outcome.warnings) {
      notes.push({ row: run.processedRows + note.position + 2, reason: note.reason, warning: true })
    }
    for (const entry of outcome.refused) refuse(entry.position, entry.reason)

    // The few the batch could not place: a second row of this same file naming
    // the record the first one made, or a unique value somebody else committed
    // in between. Rare enough to cost one round trip each, and they must not be
    // dropped, so they go the way every row used to.
    for (const position of outcome.contested) {
      const values = batch.find((row) => row.position === position)!.values
      try {
        const existing = await dedupeLookup(ctx, object, values)
        if (!existing) {
          refuse(position, 'Another record took that value while this file was importing.')
          continue
        }
        await updateRecord(ctx, object.key, existing, values, null, NO_ENRICH)
        updated += 1
      } catch (cause) {
        refuse(position, reasonOf(cause))
      }
    }
  } else {
    // A shape file: one instruction per row, each of which reads the account back
    // before it writes, so these stay one at a time. One transaction for the whole
    // chunk rather than one per row, with a savepoint per row so a refusal undoes
    // itself and leaves the rest of the chunk standing.
    await withAccount(ctx, async (tx) => {
      for (const [offset, planned] of plans.entries()) {
        // Never on the first row: a row slower than the whole budget still has to
        // advance the run rather than be retried for ever.
        if (handled > 0 && Date.now() >= deadline) return
        handled = offset + 1

        if (planned.error) {
          refuse(offset, planned.error)
          continue
        }
        if (Object.keys(planned.values).length === 0) {
          skipped += 1
          continue
        }
        for (const warning of planned.warnings) {
          notes.push({ row: run.processedRows + offset + 2, reason: warning, warning: true })
        }

        await tx.execute(sql`savepoint rawr_row`)
        try {
          if (writer) {
            const outcome = await writer(deps, planned.values)
            if (typeof outcome === 'object') refuse(offset, outcome.error)
            else if (outcome === 'created') created += 1
            else if (outcome === 'updated') updated += 1
            else skipped += 1
          } else {
            const outcome = await writeImportedActivity(ctx, findRecord, run.source, planned.values)
            if (outcome === 'created') created += 1
            else if (outcome === 'already') skipped += 1
            else refuse(offset, 'No contact or company in this account matches that address, so there is nothing to put this on.')
          }
        } catch (cause) {
          await tx.execute(sql`rollback to savepoint rawr_row`)
          refuse(offset, reasonOf(cause))
        } finally {
          // Always: an unreleased savepoint is a live subtransaction, and a chunk
          // of them nested is a transaction Postgres spends its time bookkeeping
          // rather than writing.
          await tx.execute(sql`release savepoint rawr_row`)
        }
      }
    })
  }

  // Once per run, not once per row: a portal with four departed owners produced
  // four lines, whatever the file's length.
  const previousUnmatched = (run.unmatchedOwners as string[] | null) ?? []
  const unmatchedOwners = [...new Set([...previousUnmatched, ...resolve.unmatchedOwners])].slice(0, 200)

  const processed = run.processedRows + handled
  // The file's length, not the slice's: a short slice on a run somebody cancelled
  // mid-chunk must not read as a finished import.
  const done = processed >= run.totalRows || slice.length === 0
  const previousNotes = (run.errors as RunNote[] | null) ?? []

  try {
    await withAccount(ctx, async (tx) => {
      await tx
        .update(importRun)
        .set({
          processedRows: processed,
          createdCount: sql`${importRun.createdCount} + ${created}`,
          updatedCount: sql`${importRun.updatedCount} + ${updated}`,
          skippedCount: sql`${importRun.skippedCount} + ${skipped}`,
          erroredCount: sql`${importRun.erroredCount} + ${refused.length}`,
          // The first few, for the screen. Every refused row, with its reason, is
          // in import_row for the error file, so this list never has to be whole.
          errors: [...previousNotes, ...notes].slice(0, NOTES_KEPT),
          unmatchedOwners,
          state: done ? 'done' : 'running',
          finishedAt: done ? new Date() : null,
          updatedAt: new Date(),
        })
        // A run cancelled while this chunk was in flight stays cancelled. Without
        // the state in the predicate the chunk that lost the race wrote 'done' over
        // it and the screen claimed a stopped import had finished.
        .where(and(eq(importRun.id, id), inArray(importRun.state, ['mapping', 'previewing', 'running'])))
      if (refused.length > 0) {
        await tx.execute(sql`
          update import_row r set reason = e.reason
            from jsonb_to_recordset(${JSON.stringify(refused)}::jsonb) as e(position int, reason text)
           where r.run_id = ${id}::uuid and r.position = e.position`)
      }
    })
  } catch (cause) {
    await failImportRun(ctx, id, cause)
    throw cause
  }

  if (done) await dropImportRows(ctx, id)
  return { done, processed, total: run.totalRows }
}

/** The click that starts a run. Nothing but the state changes: the chunks are the
 *  worker's, which is what lets the person close the tab. */
export const startImportRun = async (ctx: AccountContext, id: string): Promise<void> => {
  assertCanWrite(ctx, 'import_run')
  assertCanDo(ctx, 'import')
  if (!isUuid(id)) throw new Error('That import no longer exists.')
  const [run] = await withAccount(ctx, (tx) =>
    tx
      .select({
        objectType: importRun.objectType,
        importKind: importRun.importKind,
        mapping: importRun.mapping,
        state: importRun.state,
      })
      .from(importRun)
      .where(eq(importRun.id, id))
      .limit(1),
  )
  if (!run) throw new Error('That import no longer exists.')
  if (run.state === 'uploading') throw new Error(STILL_ARRIVING)

  // Before the first chunk, not during it: a column whose field or choice appears
  // halfway through the file is a column that imported nothing above that point.
  // The same reading of the file the preview showed, so the two cannot differ.
  if (run.importKind === 'records' && (run.state === 'mapping' || run.state === 'previewing')) {
    const object = await objectFor(ctx, run.importKind, run.objectType)
    const settled = await settleChoices(ctx, id, object, run.mapping as Mapping)
    await withAccount(ctx, (tx) =>
      tx.update(importRun).set({ mapping: settled.mapping, updatedAt: new Date() }).where(eq(importRun.id, id)),
    )
    for (const { field, choices } of settled.added) {
      await updateField(ctx, { id: field.id, options: [...field.options, ...choices] })
    }
  }
  await createProposedProperties(ctx, id)
  const updated = await withAccount(ctx, (tx) =>
    tx
      .update(importRun)
      .set({ state: 'running', finishedAt: null, updatedAt: new Date() })
      .where(and(eq(importRun.id, id), inArray(importRun.state, ['mapping', 'previewing', 'running'])))
      .returning({ id: importRun.id }),
  )
  if (updated.length === 0) throw new Error('That import is already over, so there is nothing to start.')
}

/** A run that cannot go on. Written so the screen can say so and stop implying
 *  the file is still being read; the rows are dropped because a failed run is not
 *  resumed. */
const failImportRun = async (ctx: AccountContext, id: string, cause: unknown): Promise<void> => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  await withAccount(ctx, (tx) =>
    tx
      .update(importRun)
      .set({
        state: 'failed',
        errors: sql`coalesce(${importRun.errors}, '[]'::jsonb) || ${JSON.stringify([{ row: 0, reason } satisfies RunNote])}::jsonb`,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(importRun.id, id)),
  ).catch(() => {
    // The run is already unrecoverable; failing to record why must not replace
    // the original error with a second one.
  })
  await dropImportRows(ctx, id).catch(() => {
    // Same reason: the rows are dead weight, not the failure worth reporting.
  })
}

/** Stopping a run for real, rather than the browser deciding to stop asking for
 *  chunks. The next chunk request returns immediately, because the guard at the
 *  top of runImportChunk already treats 'cancelled' as finished. */
export const cancelImportRun = async (ctx: AccountContext, id: string): Promise<void> => {
  assertCanWrite(ctx, 'contact')
  if (!isUuid(id)) throw new Error('That import no longer exists.')
  await withAccount(ctx, (tx) =>
    tx
      .update(importRun)
      .set({ state: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(importRun.id, id), inArray(importRun.state, ['uploading', 'mapping', 'previewing', 'running']))),
  )
  await dropImportRows(ctx, id)
}

export const readImportRun = async (
  ctx: AccountContext,
  id: string,
): Promise<ImportSummary | null> => {
  if (!isUuid(id)) return null
  const [row] = await withAccount(ctx, (tx) =>
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
        unmatchedOwners: importRun.unmatchedOwners,
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
    errors: (row.errors as RunNote[] | null) ?? [],
    unmatchedOwners: (row.unmatchedOwners as string[] | null) ?? [],
  } as ImportSummary
}

export const listImportRuns = async (ctx: AccountContext): Promise<ImportSummary[]> => {
  const rows = await withAccount(ctx, (tx) =>
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
  return rows.map((row) => ({ ...row, headers: [], errors: [], unmatchedOwners: [] })) as ImportSummary[]
}
