import { sql, type SQL } from 'drizzle-orm'
import type { AccountContext } from './context.ts'
import { withAccount } from './index.ts'
import { entityAlive, getRegistryIn, objectOrThrow, rowsOf, tableFor, type RegistryObject } from './registry.ts'

export type SearchHit = {
  objectKey: string
  id: string
  displayName: string
  detail: string | null
  rank: number
  /** Where the hit opens, when it is not a record with a page of its own. A task
   *  and an activity live on a record's page, so both name that record here and
   *  the caller routes to it. Null on a record, which is its own address. */
  parent: { objectKey: string; id: string } | null
}

/** One object's hits. Groups come back in registry order, so the three the system
 *  is built on come before whatever an admin invented, and the two that are not
 *  registry objects at all come last. */
export type SearchGroup = {
  objectKey: string
  nameSingular: string
  namePlural: string
  hits: SearchHit[]
}

export type SearchResults = { groups: SearchGroup[]; total: number }

const PER_OBJECT = 8

/** Searchable, but not objects: neither has a record page, a view or a field
 *  definition, and neither belongs in the registry for the sake of a search
 *  result. Named here, last, after everything the registry does name. */
const EXTRA: Record<string, { nameSingular: string; namePlural: string }> = {
  task: { nameSingular: 'Task', namePlural: 'Tasks' },
  activity: { nameSingular: 'Activity', namePlural: 'Activity' },
}

/** Postgres only, no search service. The tsvector is a generated column so it can
 *  never go stale, and pg_trgm covers the misspelling a full-text match misses.
 *  Sub-200ms at 88k rows is the bar; it is measured for real in F7. A7.
 *
 *  pg_trgm is schema-qualified because the transaction pooler sets its own
 *  search_path per session, so the role default from migration 0004 does not apply.
 *
 *  Objects an admin invented share the last arm and share its cap: their rows are
 *  all in one table, and one query over it is cheaper than one per object. The cost
 *  is that ten custom objects split a single screenful between them rather than
 *  getting one each. Their vector is written on the write path rather than
 *  generated, because which field names a custom record is a registry answer. */
export const searchAll = async (
  ctx: AccountContext,
  query: string,
  limitPerObject = PER_OBJECT,
): Promise<SearchResults> => {
  const trimmed = query.trim()
  if (trimmed.length === 0) return { groups: [], total: 0 }
  const limit = Math.min(Math.max(limitPerObject, 1), 25)
  const prefix = `${trimmed}%`

  return withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const rows = await tx.execute<{ object_key: string; id: string; label: string | null; detail: string | null; rank: number; parent_object: string | null; parent_id: string | null }>(sql`
      (select 'contact'::text as object_key, id,
              coalesce(nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''), email) as label,
              email as detail,
              greatest(
                ts_rank(search, plainto_tsquery('simple', ${trimmed})),
                extensions.similarity(coalesce(first_name,'') || ' ' || coalesce(last_name,''), ${trimmed})
              ) as rank,
              null::text as parent_object, null::uuid as parent_id
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
              ), null::text, null::uuid
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
              ), null::text, null::uuid
         from deal
        where deleted_at is null
          and (search @@ plainto_tsquery('simple', ${trimmed})
               or coalesce(name,'') OPERATOR(extensions.%) ${trimmed})
        order by 5 desc, created_at desc
        limit ${limit})
      union all
      (select o.key, r.id, nullif(trim(r.custom ->> f.key), ''), null::text,
              ts_rank(r.search, plainto_tsquery('simple', ${trimmed})), null::text, null::uuid
         from custom_record r
         join object_def o on o.id = r.object_id
         left join field_def f on f.id = o.label_field_id
        where r.deleted_at is null
          and r.search @@ plainto_tsquery('simple', ${trimmed})
        order by 5 desc, r.created_at desc
        limit ${limit})
      union all
      (select 'task'::text, t.id, t.title, to_char(t.due_date, 'FMDay DD Mon'),
              extensions.similarity(t.title, ${trimmed}),
              -- A task on a record that has been deleted keeps its place in the
              -- list and loses the link, rather than offering a page that 404s.
              case when ${entityAlive(sql`t.entity_type`, sql`t.entity_id`)} then t.entity_type end,
              case when ${entityAlive(sql`t.entity_type`, sql`t.entity_id`)} then t.entity_id end
         from task t
        where t.title OPERATOR(extensions.%) ${trimmed}
           or lower(t.title) like lower(${prefix})
        order by 5 desc, t.created_at desc
        limit ${limit})
      union all
      (select 'activity'::text, h.id, h.label, h.detail, h.rank, h.parent_object, h.parent_id
         from (select distinct on (a.id)
                      a.id,
                      -- A note has no subject, and "Note" eight times over says
                      -- nothing. What was written is the line worth showing.
                      coalesce(nullif(trim(a.subject), ''), nullif(trim(left(a.body, 90)), ''), initcap(a.type::text)) as label,
                      initcap(a.type::text) as detail,
                      ts_rank(a.search, plainto_tsquery('simple', ${trimmed})) as rank,
                      l.entity_type as parent_object,
                      l.entity_id as parent_id,
                      a.occurred_at
                 from activity a
                 -- An activity with no link is on nobody's timeline and has no
                 -- page to open, so it is not a result. A call logged on a contact
                 -- is linked to their company and their deals at the same instant,
                 -- so distinct on takes the contact first and only then the most
                 -- recent link: without that the tie is broken by whichever row
                 -- Postgres reached first and the note opened the company.
                 join activity_link l on l.activity_id = a.id
                where a.search @@ plainto_tsquery('simple', ${trimmed})
                  -- And the record it hangs on has to still be there. A note
                  -- outlives the contact it was written on, which is deliberate,
                  -- but offering it here sends somebody to a page that has gone.
                  and ${entityAlive(sql`l.entity_type`, sql`l.entity_id`)}
                  -- What somebody wrote or said. The system types are templated
                  -- ("changed Next step from X to Y") and repeat across thousands
                  -- of rows, so searching them buries the one note that matters.
                  -- 'task' is left out because a task is its own arm above, and
                  -- carrying both returns the same task twice under two headings.
                  and a.type in ('note', 'call', 'email', 'meeting')
                order by a.id, (l.entity_type = 'contact') desc, l.occurred_at desc, l.entity_id) h
        order by h.rank desc, h.occurred_at desc
        limit ${limit})`)

    const byObject = new Map<string, SearchHit[]>()
    for (const row of rows) {
      const unnamed = registry.byKey.get(row.object_key)?.nameSingular.toLowerCase() ?? EXTRA[row.object_key]?.nameSingular.toLowerCase()
      if (unnamed === undefined) continue
      const hit: SearchHit = {
        objectKey: row.object_key,
        id: row.id,
        displayName: row.label?.trim() || `Unnamed ${unnamed}`,
        detail: row.detail,
        rank: Number(row.rank),
        parent: row.parent_object && row.parent_id ? { objectKey: row.parent_object, id: row.parent_id } : null,
      }
      byObject.set(row.object_key, [...(byObject.get(row.object_key) ?? []), hit])
    }

    const named = (key: string, nameSingular: string, namePlural: string): SearchGroup[] => {
      const hits = byObject.get(key) ?? []
      return hits.length === 0 ? [] : [{ objectKey: key, nameSingular, namePlural, hits }]
    }

    const groups = [
      ...registry.objects.flatMap((object) => named(object.key, object.nameSingular, object.namePlural)),
      ...Object.entries(EXTRA).flatMap(([key, names]) => named(key, names.nameSingular, names.namePlural)),
    ]

    return { groups, total: groups.reduce((sum, group) => sum + group.hits.length, 0) }
  })
}

/** The hits for one object, for a caller that wants only those. */
export const hitsOf = (results: SearchResults, objectKey: string): SearchHit[] =>
  results.groups.find((group) => group.objectKey === objectKey)?.hits ?? []

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
  ctx: AccountContext,
  input: { object: string; query?: string; limit?: number; excludeId?: string | null },
): Promise<RecordOption[]> => {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50)
  const trimmed = (input.query ?? '').trim()
  const exclude = input.excludeId ?? null

  return withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, input.object)
    const { label, detail, match } = shapeOf(object)
    const rows = await tx.execute<{ id: string; label: string; detail: string | null }>(
      trimmed.length === 0
        ? sql`select id, ${label} as label, ${detail} as detail
                from ${tableFor(object)}
               where deleted_at is null and ${rowsOf(object)} ${exclude ? sql`and id <> ${exclude}` : sql``}
               order by created_at desc
               limit ${limit}`
        : sql`select id, ${label} as label, ${detail} as detail
                from ${tableFor(object)}
               where deleted_at is null and ${rowsOf(object)}
                 ${exclude ? sql`and id <> ${exclude}` : sql``}
                 and (search @@ plainto_tsquery('simple', ${trimmed})
                      or ${match} ilike ${`%${trimmed}%`})
               order by extensions.similarity(${match}, ${trimmed}) desc, created_at desc
               limit ${limit}`,
    )
    return rows.map((row) => ({ id: row.id, label: row.label, detail: row.detail }))
  })
}

/** The label and detail expression per object, so the picker reads the way the
 *  record page does. Identifiers only, never a caller's text: a custom object's
 *  key comes from the registry and a field key is validated on the way in. */
const shapeOf = (object: RegistryObject): { label: SQL; detail: SQL; match: SQL } => {
  if (object.isCustom) {
    const unnamed = `Unnamed ${object.nameSingular.toLowerCase()}`
    // No label field means an object mid-creation. Nothing to name it by, so the
    // picker shows every row as unnamed rather than failing.
    const named = object.labelFieldKey
      ? sql`coalesce("custom" ->> ${object.labelFieldKey}, '')`
      : sql`''::text`
    return {
      label: sql`coalesce(nullif(trim(${named}), ''), ${unnamed})`,
      // A custom record has one field that names it and nothing that is a
      // second line by convention.
      detail: sql`null::text`,
      match: named,
    }
  }
  switch (object.key) {
    case 'contact':
      return {
        label: sql`coalesce(nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''), email, 'Unnamed contact')`,
        detail: sql`email`,
        match: sql`coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(email,'')`,
      }
    case 'company':
      return {
        label: sql`coalesce(nullif(name, ''), domain, 'Unnamed company')`,
        detail: sql`domain`,
        match: sql`coalesce(name,'') || ' ' || coalesce(domain,'')`,
      }
    default:
      return {
        label: sql`coalesce(nullif(name, ''), 'Unnamed deal')`,
        detail: sql`next_step`,
        match: sql`coalesce(name,'')`,
      }
  }
}
