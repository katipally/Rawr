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
}

export type AssociationRail = {
  contacts: AssociatedRecord[]
  companies: AssociatedRecord[]
  deals: AssociatedRecord[]
}

const NAME_SELECT: Record<ObjectKey, string> = {
  contact: `id, coalesce(nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''), email) as name, title as detail`,
  company: `id, coalesce(name, domain) as name, domain as detail`,
  deal: `id, name, next_step as detail`,
}

type Row = { id: string; name: string | null; detail: string | null }

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
 *  the association table. */
export const readAssociations = async (
  ctx: WorkspaceContext,
  entity: EntityRef,
): Promise<AssociationRail> =>
  withWorkspace(ctx, async (tx) => {
    const rail: AssociationRail = { contacts: [], companies: [], deals: [] }
    const { entityType, entityId } = entity

    // The relationship a record stores on itself.
    if (entityType === 'contact' || entityType === 'deal') {
      const [row] = await tx.execute<{ company_id: string | null }>(
        sql`select company_id from ${sql.raw(`"${entityType}"`)} where id = ${entityId} limit 1`,
      )
      if (row?.company_id) {
        const found = await fetchByIds(tx, 'company', [row.company_id])
        const company = found.get(row.company_id)
        // No label: isPrimary already renders the "Primary" badge, and setting both
        // printed the word twice on the same row.
        if (company) rail.companies.push(toRecord('company', company, true, null))
      }
    }
    if (entityType === 'company') {
      const contacts = await tx.execute<Row>(sql`
        select ${sql.raw(NAME_SELECT.contact)} from contact
         where company_id = ${entityId} and deleted_at is null
         order by created_at desc limit 100`)
      rail.contacts.push(...contacts.map((row) => toRecord('contact', row, true, null)))

      const deals = await tx.execute<Row>(sql`
        select ${sql.raw(NAME_SELECT.deal)} from deal
         where company_id = ${entityId} and deleted_at is null
         order by created_at desc limit 100`)
      rail.deals.push(...deals.map((row) => toRecord('deal', row, true, null)))
    }

    // Rows in the association table, in both directions.
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

    for (const [objectKey, ids] of grouped) {
      const found = await fetchByIds(tx, objectKey, ids)
      const bucket = objectKey === 'contact' ? rail.contacts : objectKey === 'company' ? rail.companies : rail.deals
      for (const id of ids) {
        const row = found.get(id)
        if (!row || bucket.some((existing) => existing.id === id)) continue
        const label = links.find((l) => l.other_id === id)?.label ?? null
        bucket.push(toRecord(objectKey, row, false, label))
      }
    }

    return rail
  })

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
