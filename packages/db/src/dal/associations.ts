import { sql } from 'drizzle-orm'
import type { ObjectKey } from '../registry/core.ts'
import { recordActivity, type EntityRef, type EntityType } from './activity.ts'
import type { WorkspaceContext } from './context.ts'
import { mutate, withWorkspace, type Tx } from './index.ts'

export type AssociatedRecord = {
  id: string
  objectKey: ObjectKey
  displayName: string
  detail: string | null
  /** True for the relationship the record itself stores, as opposed to a row in
   *  the association table. A contact has one primary company. A4. */
  isPrimary: boolean
  label: string | null
  /** When the record itself was created, which is what "recent" orders by. */
  createdAt: string | null
}

export type AssociationRail = {
  contacts: AssociatedRecord[]
  companies: AssociatedRecord[]
  deals: AssociatedRecord[]
  /** How many are linked, before a search narrowed them, so the count on a card
   *  says how many there are rather than how many match what was typed. */
  totals: { contacts: number; companies: number; deals: number }
}

/** Newest link first is what a rail is for; alphabetical is what a long one
 *  needs. Both are applied over the loaded page, which is capped per object. */
export type AssociationSort = 'recent' | 'name'

const NAME_SELECT: Record<ObjectKey, string> = {
  contact: `id, coalesce(nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''), email) as name, title as detail, created_at`,
  company: `id, coalesce(name, domain) as name, domain as detail, created_at`,
  deal: `id, name, next_step as detail, created_at`,
}

type Row = { id: string; name: string | null; detail: string | null; created_at: string | Date | null }

const UNNAMED: Record<ObjectKey, string> = {
  contact: 'Unnamed contact',
  company: 'Unnamed company',
  deal: 'Unnamed deal',
}

const toRecord = (objectKey: ObjectKey, row: Row, isPrimary: boolean, label: string | null): AssociatedRecord => ({
  id: row.id,
  objectKey,
  displayName: row.name?.trim() || UNNAMED[objectKey],
  detail: row.detail,
  isPrimary,
  label,
  createdAt: row.created_at === null ? null : new Date(row.created_at).toISOString(),
})

const fetchByIds = async (tx: Tx, objectKey: ObjectKey, ids: string[]): Promise<Map<string, Row>> => {
  if (ids.length === 0) return new Map()
  const rows = await tx.execute<Row>(sql`
    select ${sql.raw(NAME_SELECT[objectKey])}
      from ${sql.raw(`"${objectKey}"`)}
     where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) and deleted_at is null`)
  return new Map(rows.map((row) => [row.id, row]))
}

/** Everything the right rail shows, in one place, so the record page never has to
 *  know that a company link is a column on the contact and a deal link is a row in
 *  the association table.
 *
 *  A search narrows what comes back; the totals do not move, because the count on
 *  a card says how many are linked, not how many matched what was typed. */
export const readAssociations = async (
  ctx: WorkspaceContext,
  entity: EntityRef,
  options: { q?: string | undefined; sort?: AssociationSort | undefined } = {},
): Promise<AssociationRail> =>
  withWorkspace(ctx, async (tx) => {
    const { entityType, entityId } = entity
    const needle = options.q?.trim().toLowerCase()
    const sort = options.sort ?? 'recent'
    const totals = { contacts: 0, companies: 0, deals: 0 }
    const own: Record<'contacts' | 'companies' | 'deals', AssociatedRecord[]> = {
      contacts: [],
      companies: [],
      deals: [],
    }

    // Applied in SQL for the reads that are capped, so searching a company with
    // four hundred contacts looks at all of them rather than at whichever hundred
    // the cap happened to load.
    const matching = (expression: string) =>
      needle ? sql`and lower(${sql.raw(expression)}) like ${`%${needle}%`}` : sql``
    const orderedBy = (expression: string) =>
      sort === 'name' ? sql`order by ${sql.raw(expression)} asc nulls last` : sql`order by created_at desc`

    // The relationship a record stores on itself.
    if (entityType === 'contact' || entityType === 'deal') {
      const [row] = await tx.execute<{ company_id: string | null }>(
        sql`select company_id from ${sql.raw(`"${entityType}"`)} where id = ${entityId} limit 1`,
      )
      if (row?.company_id) {
        totals.companies += 1
        const company = (await fetchByIds(tx, 'company', [row.company_id])).get(row.company_id)
        // No label: isPrimary already renders the "Primary" badge, and setting both
        // printed the word twice on the same row.
        if (company && keeps(company, needle)) own.companies.push(toRecord('company', company, true, null))
      }
    }

    if (entityType === 'company') {
      const contactName = `coalesce(nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''), email, '')`
      const contacts = await tx.execute<Row>(sql`
        select ${sql.raw(NAME_SELECT.contact)} from contact
         where company_id = ${entityId} and deleted_at is null ${matching(contactName)}
         ${orderedBy(contactName)} limit 100`)
      own.contacts.push(...contacts.map((row) => toRecord('contact', row, true, null)))

      const deals = await tx.execute<Row>(sql`
        select ${sql.raw(NAME_SELECT.deal)} from deal
         where company_id = ${entityId} and deleted_at is null ${matching(`coalesce(name, '')`)}
         ${orderedBy('name')} limit 100`)
      own.deals.push(...deals.map((row) => toRecord('deal', row, true, null)))

      // Its own query, because both the cap and the search narrow the two above.
      const [counted] = await tx.execute<{ contacts: number; deals: number }>(sql`
        select (select count(*)::int from contact where company_id = ${entityId} and deleted_at is null) as contacts,
               (select count(*)::int from deal where company_id = ${entityId} and deleted_at is null) as deals`)
      totals.contacts += counted?.contacts ?? 0
      totals.deals += counted?.deals ?? 0
    }

    // Rows in the association table, in both directions. Never capped, so these
    // are counted and narrowed here rather than in SQL.
    const links = await tx.execute<{ other_type: EntityType; other_id: string; label: string | null }>(sql`
      select to_type as other_type, to_id as other_id, label from association
       where from_type = ${entityType} and from_id = ${entityId}
      union all
      select from_type as other_type, from_id as other_id, label from association
       where to_type = ${entityType} and to_id = ${entityId}`)

    const grouped = new Map<ObjectKey, string[]>()
    for (const link of links) {
      grouped.set(link.other_type, [...(grouped.get(link.other_type) ?? []), link.other_id])
    }

    const linked: Record<'contacts' | 'companies' | 'deals', AssociatedRecord[]> = {
      contacts: [],
      companies: [],
      deals: [],
    }
    for (const [objectKey, ids] of grouped) {
      const found = await fetchByIds(tx, objectKey, ids)
      const bucket = bucketOf(objectKey)
      const seen = new Set(own[bucket].map((record) => record.id))
      for (const id of ids) {
        const row = found.get(id)
        if (!row || seen.has(id)) continue
        seen.add(id)
        totals[bucket] += 1
        if (!keeps(row, needle)) continue
        const label = links.find((link) => link.other_id === id)?.label ?? null
        linked[bucket].push(toRecord(objectKey, row, false, label))
      }
    }

    const order = (records: AssociatedRecord[]): AssociatedRecord[] =>
      [...records].sort((a, b) =>
        sort === 'name'
          ? a.displayName.localeCompare(b.displayName)
          : (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
      )

    // What the record holds itself comes first: a contact's own company is the
    // primary one, and a company's own contacts are the ones that belong to it.
    return {
      contacts: [...own.contacts, ...order(linked.contacts)],
      companies: [...own.companies, ...order(linked.companies)],
      deals: [...own.deals, ...order(linked.deals)],
      totals,
    }
  })

const bucketOf = (objectKey: ObjectKey): 'contacts' | 'companies' | 'deals' =>
  objectKey === 'contact' ? 'contacts' : objectKey === 'company' ? 'companies' : 'deals'

const keeps = (row: Row, needle: string | undefined): boolean =>
  !needle ||
  (row.name ?? '').toLowerCase().includes(needle) ||
  (row.detail ?? '').toLowerCase().includes(needle)

const nameOf = async (tx: Tx, ref: EntityRef): Promise<string> => {
  const [row] = await tx.execute<Row>(sql`
    select ${sql.raw(NAME_SELECT[ref.entityType])} from ${sql.raw(`"${ref.entityType}"`)} where id = ${ref.entityId} limit 1`)
  return row?.name ?? 'a deleted record'
}

/** Stored once, in a stable direction, so the same pair cannot exist twice under
 *  two orderings. */
const ordered = (a: EntityRef, b: EntityRef): [EntityRef, EntityRef] =>
  a.entityType < b.entityType || (a.entityType === b.entityType && a.entityId < b.entityId) ? [a, b] : [b, a]

export const associate = async (
  ctx: WorkspaceContext,
  a: EntityRef,
  b: EntityRef,
  label?: string | null,
): Promise<void> =>
  mutate(ctx, 'association', async (tx) => {
    if (a.entityType === b.entityType && a.entityId === b.entityId) {
      throw new Error('A record cannot be associated with itself.')
    }
    const [from, to] = ordered(a, b)
    await tx.execute(sql`
      insert into association (workspace_id, from_type, from_id, to_type, to_id, label)
      values (${ctx.workspaceId}, ${from.entityType}, ${from.entityId}, ${to.entityType}, ${to.entityId}, ${label ?? null})
      on conflict (workspace_id, from_type, from_id, to_type, to_id) do update set label = excluded.label`)

    const [fromName, toName] = await Promise.all([nameOf(tx, from), nameOf(tx, to)])
    await recordActivity(tx, ctx, {
      type: 'association_change',
      subject: `${fromName} was associated with ${toName}`,
      payload: { from, to, label: label ?? null },
      links: [from, to],
    })

    return {
      result: undefined,
      audit: { entity: 'association', entityId: to.entityId, action: 'associate', before: null, after: { from, to, label } },
    }
  })

export const dissociate = async (ctx: WorkspaceContext, a: EntityRef, b: EntityRef): Promise<void> =>
  mutate(ctx, 'association', async (tx) => {
    const [from, to] = ordered(a, b)
    const removed = await tx.execute(sql`
      delete from association
       where from_type = ${from.entityType} and from_id = ${from.entityId}
         and to_type = ${to.entityType} and to_id = ${to.entityId}
      returning to_id`)

    if (removed.length === 0) throw new Error('Those records are not associated.')

    const [fromName, toName] = await Promise.all([nameOf(tx, from), nameOf(tx, to)])
    await recordActivity(tx, ctx, {
      type: 'association_change',
      subject: `${fromName} was unlinked from ${toName}`,
      payload: { from, to },
      links: [from, to],
    })

    return {
      result: undefined,
      audit: { entity: 'association', entityId: to.entityId, action: 'dissociate', before: { from, to }, after: null },
    }
  })
