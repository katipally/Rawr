import { sql } from 'drizzle-orm'
import type { ObjectKey } from '../registry/core.ts'
import type { WorkspaceContext } from './context.ts'
import { withWorkspace } from './index.ts'

export type SearchHit = {
  objectKey: ObjectKey
  id: string
  displayName: string
  detail: string | null
  rank: number
}

export type SearchResults = {
  contacts: SearchHit[]
  companies: SearchHit[]
  deals: SearchHit[]
  total: number
}

const PER_OBJECT = 8

/** Postgres only, no search service. The tsvector is a generated column so it can
 *  never go stale, and pg_trgm covers the misspelling a full-text match misses.
 *  Sub-200ms at 88k rows is the bar; it is measured for real in F7. A7.
 *
 *  pg_trgm is schema-qualified because the transaction pooler sets its own
 *  search_path per session, so the role default from migration 0004 does not apply. */
export const searchAll = async (
  ctx: WorkspaceContext,
  query: string,
  limitPerObject = PER_OBJECT,
): Promise<SearchResults> => {
  const trimmed = query.trim()
  if (trimmed.length === 0) return { contacts: [], companies: [], deals: [], total: 0 }
  const limit = Math.min(Math.max(limitPerObject, 1), 25)
  const prefix = `${trimmed}%`

  const rows = await withWorkspace(ctx, (tx) =>
    tx.execute<{ object_key: ObjectKey; id: string; label: string | null; detail: string | null; rank: number }>(sql`
      (select 'contact'::text as object_key, id,
              coalesce(nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''), email) as label,
              email as detail,
              greatest(
                ts_rank(search, plainto_tsquery('simple', ${trimmed})),
                extensions.similarity(coalesce(first_name,'') || ' ' || coalesce(last_name,''), ${trimmed})
              ) as rank
         from contact
        where deleted_at is null
          and (search @@ plainto_tsquery('simple', ${trimmed})
               or lower(email) like lower(${prefix})
               or (coalesce(first_name,'') || ' ' || coalesce(last_name,'')) OPERATOR(extensions.%) ${trimmed})
        order by rank desc, created_at desc
        limit ${limit})
      union all
      (select 'company'::text, id, coalesce(name, domain), domain,
              greatest(
                ts_rank(search, plainto_tsquery('simple', ${trimmed})),
                extensions.similarity(coalesce(name, ''), ${trimmed})
              )
         from company
        where deleted_at is null
          and (search @@ plainto_tsquery('simple', ${trimmed})
               or lower(domain) like lower(${prefix})
               or coalesce(name,'') OPERATOR(extensions.%) ${trimmed})
        order by 5 desc, created_at desc
        limit ${limit})
      union all
      (select 'deal'::text, id, name, next_step,
              greatest(
                ts_rank(search, plainto_tsquery('simple', ${trimmed})),
                extensions.similarity(coalesce(name, ''), ${trimmed})
              )
         from deal
        where deleted_at is null
          and (search @@ plainto_tsquery('simple', ${trimmed})
               or coalesce(name,'') OPERATOR(extensions.%) ${trimmed})
        order by 5 desc, created_at desc
        limit ${limit})`),
  )

  const unnamed: Record<ObjectKey, string> = {
    contact: 'Unnamed contact',
    company: 'Unnamed company',
    deal: 'Unnamed deal',
  }

  const results: SearchResults = { contacts: [], companies: [], deals: [], total: rows.length }
  for (const row of rows) {
    const hit: SearchHit = {
      objectKey: row.object_key,
      id: row.id,
      displayName: row.label?.trim() || unnamed[row.object_key],
      detail: row.detail,
      rank: Number(row.rank),
    }
    if (row.object_key === 'contact') results.contacts.push(hit)
    else if (row.object_key === 'company') results.companies.push(hit)
    else results.deals.push(hit)
  }
  return results
}

export type RecordOption = { id: string; label: string; detail: string | null }

/** What every record picker reads: a short, ranked, server-side answer to "which
 *  record did you mean".
 *
 *  The pickers used to be fixed lists — the 500 alphabetically first companies, the
 *  200 most recently created contacts — which is fine against seed data and useless
 *  against 34,648 companies. Nothing in this project may hold a whole object in a
 *  select element, so the query goes to Postgres and comes back with at most a
 *  screenful. An empty query returns the most recent, because that is what somebody
 *  who has just created a record is looking for. */
export const recordOptions = async (
  ctx: WorkspaceContext,
  input: { object: ObjectKey; query?: string; limit?: number; excludeId?: string | null },
): Promise<RecordOption[]> => {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50)
  const trimmed = (input.query ?? '').trim()
  const exclude = input.excludeId ?? null

  // The label and detail expression per object, so the picker reads the way the
  // record page does. Identifiers only, never a caller's text.
  const shape: Record<ObjectKey, { label: string; detail: string; match: string }> = {
    contact: {
      label: `coalesce(nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''), email, 'Unnamed contact')`,
      detail: 'email',
      match: `coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(email,'')`,
    },
    company: {
      label: `coalesce(nullif(name, ''), domain, 'Unnamed company')`,
      detail: 'domain',
      match: `coalesce(name,'') || ' ' || coalesce(domain,'')`,
    },
    deal: {
      label: `coalesce(nullif(name, ''), 'Unnamed deal')`,
      detail: 'next_step',
      match: `coalesce(name,'')`,
    },
  }
  const { label, detail, match } = shape[input.object]
  const table = sql.raw(`"${input.object}"`)

  return withWorkspace(ctx, async (tx) => {
    const rows = await tx.execute<{ id: string; label: string; detail: string | null }>(
      trimmed.length === 0
        ? sql`select id, ${sql.raw(label)} as label, ${sql.raw(`"${detail}"`)} as detail
                from ${table}
               where deleted_at is null ${exclude ? sql`and id <> ${exclude}` : sql``}
               order by created_at desc
               limit ${limit}`
        : sql`select id, ${sql.raw(label)} as label, ${sql.raw(`"${detail}"`)} as detail
                from ${table}
               where deleted_at is null
                 ${exclude ? sql`and id <> ${exclude}` : sql``}
                 and (search @@ plainto_tsquery('simple', ${trimmed})
                      or ${sql.raw(match)} ilike ${`%${trimmed}%`})
               order by extensions.similarity(${sql.raw(match)}, ${trimmed}) desc, created_at desc
               limit ${limit}`,
    )
    return rows.map((row) => ({ id: row.id, label: row.label, detail: row.detail }))
  })
}
