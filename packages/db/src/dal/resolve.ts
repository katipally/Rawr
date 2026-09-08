import { sql, type SQL } from 'drizzle-orm'
import type { ObjectKey } from '../registry/core.ts'
import type { AccountContext } from './context.ts'
import { withAccount } from './index.ts'
import { getRegistryIn, objectOrThrow, type RegistryObject } from './registry.ts'

/** F5 §3. Turning "MGG production opportunity" into one record, or refusing to.
 *
 *  Trevor does not say UUIDs. Resolution is therefore not a convenience on top of
 *  the tools, it is the feature, and the one rule that matters is that a write
 *  never proceeds on an ambiguous reference. Picking one silently is the failure
 *  that would lose trust permanently, so a tie comes back as a question with
 *  enough detail on each candidate that the answer is obvious. */

export type RecordCandidate = {
  objectKey: string
  id: string
  displayName: string
  /** Stage, amount, company and close date for a deal; the email and company for a
   *  contact. Whatever makes two rows with similar names tell themselves apart. */
  detail: string
  score: number
}

export type Resolution =
  | { kind: 'one'; record: RecordCandidate }
  | { kind: 'many'; candidates: RecordCandidate[] }
  | { kind: 'none'; suggestions: RecordCandidate[] }

/** Below this a trigram match is a coincidence rather than a near miss. Chosen so
 *  "MGG" against "MGG Production Opportunity" resolves and "Acme" against
 *  "Academy Trust" does not. */
const CONFIDENT = 0.32
const SUGGEST = 0.12
const MAX_CANDIDATES = 5

type Row = { id: string; label: string | null; detail: string | null; score: number }

/** One shape per object: the readable name, the line that distinguishes it, and
 *  the text a fuzzy match is measured against. Separate from F1's search because
 *  that ranks across everything for a human scanning a list; this one has to
 *  decide, and needs a comparable score to decide with. */
const QUERIES: Record<ObjectKey, (needle: string) => SQL> = {
  deal: (needle) => sql`
    select d.id,
           d.name as label,
           concat_ws(' · ',
             s.name,
             nullif(concat_ws(' ', d.currency, to_char(d.amount, 'FM999,999,999,990.00')), ''),
             c.name,
             case when d.close_date is null then null else 'closes ' || to_char(d.close_date, 'DD Mon YYYY') end
           ) as detail,
           extensions.similarity(coalesce(d.name, ''), ${needle}) as score
      from deal d
      join pipeline_stage s on s.id = d.stage_id
      left join company c on c.id = d.company_id
     where d.deleted_at is null`,

  contact: (needle) => sql`
    select k.id,
           nullif(trim(concat_ws(' ', k.first_name, k.last_name)), '') as label,
           concat_ws(' · ', k.email, c.name, k.title) as detail,
           greatest(
             extensions.similarity(coalesce(concat_ws(' ', k.first_name, k.last_name), ''), ${needle}),
             extensions.similarity(coalesce(k.email, ''), ${needle})
           ) as score
      from contact k
      left join company c on c.id = k.company_id
     where k.deleted_at is null`,

  company: (needle) => sql`
    select c.id,
           c.name as label,
           concat_ws(' · ', c.domain, c.industry, c.country) as detail,
           greatest(
             extensions.similarity(coalesce(c.name, ''), ${needle}),
             extensions.similarity(coalesce(c.domain, ''), ${needle})
           ) as score
      from company c
     where c.deleted_at is null`,
}

/** The name column an exact match is tested against. An email or a domain is an
 *  exact identifier too, which is why a contact and a company have two. */
const EXACT: Record<ObjectKey, (needle: string) => SQL> = {
  deal: (needle) => sql`lower(coalesce(d.name, '')) = lower(${needle})`,
  contact: (needle) => sql`
    lower(coalesce(nullif(trim(concat_ws(' ', k.first_name, k.last_name)), ''), '')) = lower(${needle})
    or lower(coalesce(k.email, '')) = lower(${needle})`,
  company: (needle) => sql`
    lower(coalesce(c.name, '')) = lower(${needle})
    or lower(coalesce(c.domain, '')) = lower(${needle})`,
}

/** The index-using half of the fuzzy step. `%` is the trigram operator and is what
 *  reads the GIN index; the similarity in the select only ranks what it returns, so
 *  without this the scan is every row in the table. Schema-qualified because the
 *  transaction pooler sets its own search_path per session. */
const TRIGRAM: Record<ObjectKey, (needle: string) => SQL> = {
  deal: (needle) => sql`coalesce(d.name, '') OPERATOR(extensions.%) ${needle}`,
  contact: (needle) => sql`
    coalesce(concat_ws(' ', k.first_name, k.last_name), '') OPERATOR(extensions.%) ${needle}
    or coalesce(k.email, '') OPERATOR(extensions.%) ${needle}`,
  company: (needle) => sql`
    coalesce(c.name, '') OPERATOR(extensions.%) ${needle}
    or coalesce(c.domain, '') OPERATOR(extensions.%) ${needle}`,
}

/** A UUID is already an answer. Accepted so an agent that read an id from a search
 *  result can use it directly instead of round-tripping the name. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const resolveRecord = async (
  ctx: AccountContext,
  objectKey: string,
  query: string,
): Promise<Resolution> => {
  const needle = query.trim()
  if (!needle) return { kind: 'none', suggestions: [] }

  return withAccount(ctx, async (tx) => {
    const object = objectOrThrow(await getRegistryIn(tx), objectKey)
    const base = object.isCustom ? customQuery(object, needle) : QUERIES[objectKey as ObjectKey](needle)
    const exactly = object.isCustom ? customExact(object, needle) : EXACT[objectKey as ObjectKey](needle)
    const roughly = object.isCustom ? customTrigram(object, needle) : TRIGRAM[objectKey as ObjectKey](needle)

    if (UUID.test(needle)) {
      const rows = await tx.execute<Row>(sql`${base} and ${sql.raw(alias(object))}.id = ${needle} limit 1`)
      const row = rows[0]
      return row
        ? ({ kind: 'one', record: toCandidate(object.key, row) } as const)
        : ({ kind: 'none', suggestions: [] } as const)
    }

    // Step 1. An exact name wins outright, even against a better-scoring near miss,
    // because somebody who typed the whole name meant that record.
    const exact = await tx.execute<Row>(
      sql`${base} and (${exactly}) order by score desc limit ${MAX_CANDIDATES + 1}`,
    )
    if (exact.length === 1) return { kind: 'one', record: toCandidate(object.key, exact[0]!) }
    if (exact.length > 1) {
      return { kind: 'many', candidates: exact.slice(0, MAX_CANDIDATES).map((r) => toCandidate(object.key, r)) }
    }

    // Step 2. Fuzzy, over the rows the trigram index says are worth scoring.
    const near = await tx.execute<Row>(sql`
      with matches as (${base} and (${roughly}))
      select * from matches
       where score >= ${SUGGEST}
       order by score desc, label asc
       limit ${MAX_CANDIDATES + 1}`)

    const confident = near.filter((row) => Number(row.score) >= CONFIDENT)
    if (confident.length === 1) return { kind: 'one', record: toCandidate(object.key, confident[0]!) }
    if (confident.length > 1) {
      return {
        kind: 'many',
        candidates: confident.slice(0, MAX_CANDIDATES).map((r) => toCandidate(object.key, r)),
      }
    }

    // Step 4. Nothing close enough to act on. The near misses go back as
    // suggestions so the next attempt succeeds instead of guessing again.
    return {
      kind: 'none',
      suggestions: near.slice(0, MAX_CANDIDATES).map((r) => toCandidate(object.key, r)),
    }
  })
}

const alias = (object: RegistryObject): string =>
  object.isCustom ? 'r' : object.key === 'deal' ? 'd' : object.key === 'contact' ? 'k' : 'c'

const toCandidate = (objectKey: string, row: Row): RecordCandidate => ({
  objectKey,
  id: row.id,
  displayName: row.label?.trim() || '(no name)',
  detail: row.detail?.trim() || '',
  score: Number(row.score),
})

/** The sentence the agent shows a person when resolution could not decide. Written
 *  here rather than in the tool so the wording is the same everywhere. */
export const describeAmbiguity = (
  /** Named rather than keyed, so an object an admin invented reads as "3 Projects
   *  match" and not as "3 projects". */
  names: { singular: string; plural: string },
  query: string,
  candidates: RecordCandidate[],
): string => {
  if (candidates.length === 0) {
    return `No ${names.singular.toLowerCase()} matches "${query}". Nothing was changed. Try a search first, or give the exact name.`
  }
  const lines = candidates.map((c) => `  - ${c.displayName}${c.detail ? ` (${c.detail})` : ''} (id ${c.id})`)
  return [
    `"${query}" matches ${candidates.length} ${names.plural.toLowerCase()}. Nothing was changed. Which one?`,
    ...lines,
    'Call again with the id.',
  ].join('\n')
}

/** The same three expressions for an object an admin invented, built from its
 *  registry entry rather than written out.
 *
 *  There is no trigram index behind these: the core three index a name column and
 *  a custom record's name is a jsonb key, so the fuzzy step here is a scan of one
 *  object's rows. That is the right trade at the size a custom object is, and it
 *  is the reason the exact step below runs first. */
const customLabel = (object: RegistryObject): SQL =>
  object.labelFieldKey ? sql`coalesce(r.custom ->> ${object.labelFieldKey}, '')` : sql`''::text`

const customQuery = (object: RegistryObject, needle: string): SQL => sql`
  select r.id,
         nullif(trim(${customLabel(object)}), '') as label,
         null::text as detail,
         extensions.similarity(${customLabel(object)}, ${needle}) as score
    from custom_record r
   where r.deleted_at is null and r.object_id = ${object.id}::uuid`

const customExact = (object: RegistryObject, needle: string): SQL =>
  sql`lower(${customLabel(object)}) = lower(${needle})`

const customTrigram = (object: RegistryObject, needle: string): SQL =>
  sql`${customLabel(object)} OPERATOR(extensions.%) ${needle}`
