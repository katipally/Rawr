import { sql, type SQL } from 'drizzle-orm'
import type { ObjectKey } from '../registry/core.ts'

/** What a search box matches against: the three core objects, or any custom object. */
export type SearchKind = ObjectKey | 'custom'

/** The words typed, trimmed. Each one has to be found in the record; order does not matter. */
export const fragmentsOf = (term: string): string[] => term.trim().split(/\s+/).filter(Boolean)

/** A fragment as an ILIKE pattern that finds it anywhere. Postgres treats a backslash as
 *  the escape character in LIKE, so the fragment's own %, _ and \ are escaped and match
 *  themselves. */
export const containsPattern = (fragment: string): string => `%${fragment.replace(/[\\%_]/g, '\\$&')}%`

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

/** What a custom record is findable by: every textual value its object's fields hold,
 *  in one string.
 *
 *  A core table generates its own search column from named columns, and Postgres keeps
 *  it in step. The shared table cannot, because the fields are whatever the admin made,
 *  so the text is written on every write and on every field archive, restore and purge.
 *
 *  Built from a jsonb expression rather than from the values in hand, so the insert and
 *  the update share it. An update merges the incoming keys into the stored blob, so the
 *  text has to come from the merged result. */
export const searchTextFrom = (object: { fields: readonly { key: string; type: string }[] }, blob: SQL): SQL => {
  const parts = object.fields
    .filter((field) => TEXTUAL_FOR_SEARCH.has(field.type))
    .map((field) => sql`${blob} ->> ${field.key}`)
  if (parts.length === 0) return sql`''::text`
  return sql`concat_ws(' ', ${sql.join(parts, sql`, `)})`
}

/** The same text as the words a whole-word search reads. 'simple' rather than a stemming
 *  dictionary, matching the core tables: stemming mangles company and person names. */
export const searchVectorFrom = (object: { fields: readonly { key: string; type: string }[] }, blob: SQL): SQL =>
  sql`to_tsvector('simple'::regconfig, ${searchTextFrom(object, blob)})`

const TEXT_COLUMNS: Record<ObjectKey, string[]> = {
  contact: ['first_name', 'last_name', 'email', 'title'],
  company: ['name', 'domain', 'industry', 'city', 'country'],
  deal: ['name', 'next_step', 'deal_type'],
}

/** A contact or deal is also found by the name of its company. The company ids come from
 *  an uncorrelated subquery, so Postgres runs it once rather than once per row. */
const viaCompany = (alias: string, pattern: string): SQL =>
  sql`${sql.raw(`"${alias}"."company_id"`)} = any(array(select id from company where deleted_at is null and coalesce(name, '') ilike ${pattern}))`

/** One fragment against one row: the row's own text, or for a contact or deal the name of its company. */
const recordMatch =
  (kind: SearchKind, alias: string) =>
  (pattern: string): SQL => {
    if (kind === 'custom') return sql`${sql.raw(`"${alias}"."search_text"`)} ilike ${pattern}`
    const text = sql.raw(TEXT_COLUMNS[kind].map((column) => `coalesce("${alias}"."${column}", '')`).join(` || ' ' || `))
    const own = sql`${text} ilike ${pattern}`
    return kind === 'company' ? own : sql`(${own} or ${viaCompany(alias, pattern)})`
  }

/** Every fragment must match, each by whatever `match` says. Null when there is nothing to search for. */
export const everyFragment = (term: string, match: (pattern: string) => SQL): SQL | null => {
  const fragments = fragmentsOf(term)
  if (fragments.length === 0) return null
  return sql`(${sql.join(fragments.map((fragment) => match(containsPattern(fragment))), sql` and `)})`
}

/** The list and KPI search for a record kind. `alias` is the table or alias the rows are read from. */
export const recordTermMatch = (term: string, kind: SearchKind, alias: string): SQL | null =>
  everyFragment(term, recordMatch(kind, alias))
