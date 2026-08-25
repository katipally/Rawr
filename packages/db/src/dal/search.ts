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
