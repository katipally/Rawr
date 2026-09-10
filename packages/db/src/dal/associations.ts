import { sql, type SQL } from 'drizzle-orm'
import { recordActivity, type EntityRef, type EntityType } from './activity.ts'
import type { AccountContext } from './context.ts'
import { mutate, withAccount, type Tx } from './index.ts'
import { getRegistryIn, objectOrThrow, rowsOf, tableFor, type Registry, type RegistryObject } from './registry.ts'

export type AssociatedRecord = {
  id: string
  objectKey: string
  displayName: string
  detail: string | null
  /** True only where the record names one other record as its primary: a contact
   *  or a deal, and the single company it points at. The reverse of that link is
   *  not primary, because a company has no primary contact. A4. */
  isPrimary: boolean
  /** Only an association row can be unlinked from here. What a record stores on
   *  itself is changed on the record instead, so the rail offers no button that
   *  would be refused. */
  canUnlink: boolean
  /** Only a contact has one. What the record page's Email action opens the
   *  composer on when the record itself has no address. */
  email: string | null
  label: string | null
  /** When the record itself was created, which is what "recent" orders by. */
  createdAt: string | null
}

/** One card on the rail: everything of one object that is linked to this record. */
export type AssociationGroup = {
  objectKey: string
  nameSingular: string
  namePlural: string
  records: AssociatedRecord[]
  /** How many are linked, before a search narrowed them, so the count on a card
   *  says how many there are rather than how many match what was typed. */
  total: number
}

/** In registry order: the three the system is built on, then invented ones by
 *  name. */
export type AssociationRail = { groups: AssociationGroup[] }

export const groupFor = (rail: AssociationRail, objectKey: string): AssociationGroup | undefined =>
  rail.groups.find((group) => group.objectKey === objectKey)

/** Newest link first is what a rail is for; alphabetical is what a long one
 *  needs. Both are applied over the loaded page, which is capped per object. */
export type AssociationSort = 'recent' | 'name'

/** What a record of this object is called, and the one line under it.
 *
 *  The core three each know their own naming rule and have columns to build it
 *  from. A custom object has one field the admin nominated, in the jsonb blob,
 *  and nothing sensible to put underneath. */
const nameSelect = (object: RegistryObject): SQL => {
  if (object.isCustom) {
    const label = object.labelFieldKey
    return label
      ? sql`id, nullif(trim("custom" ->> ${label}), '') as name, null::text as detail, created_at`
      : sql`id, null::text as name, null::text as detail, created_at`
  }
  switch (object.key) {
    case 'contact':
      return sql`id, coalesce(nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''), email) as name, title as detail, email, created_at`
    case 'company':
      return sql`id, coalesce(name, domain) as name, domain as detail, created_at`
    default:
      return sql`id, name, next_step as detail, created_at`
  }
}

/** email is selected for a contact and left off every other object's select, so
 *  it is absent rather than null on those rows. */
type Row = { id: string; name: string | null; detail: string | null; email?: string | null; created_at: string | Date | null }

type Kind = 'primary' | 'own' | 'linked'

const toRecord = (object: RegistryObject, row: Row, kind: Kind, label: string | null): AssociatedRecord => ({
  id: row.id,
  objectKey: object.key,
  displayName: row.name?.trim() || `Unnamed ${object.nameSingular.toLowerCase()}`,
  detail: row.detail,
  isPrimary: kind === 'primary',
  canUnlink: kind === 'linked',
  email: row.email ?? null,
  label,
  createdAt: row.created_at === null ? null : new Date(row.created_at).toISOString(),
})

const fetchByIds = async (tx: Tx, object: RegistryObject, ids: string[]): Promise<Map<string, Row>> => {
  if (ids.length === 0) return new Map()
  const rows = await tx.execute<Row>(sql`
    select ${nameSelect(object)}
      from ${tableFor(object)}
     where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
       and deleted_at is null and ${rowsOf(object)}`)
  return new Map(rows.map((row) => [row.id, row]))
}

/** Everything the right rail shows, in one place, so the record page never has to
 *  know that a company link is a column on the contact and a deal link is a row in
 *  the association table.
 *
 *  A search narrows what comes back; the totals do not move, because the count on
 *  a card says how many are linked, not how many matched what was typed. */
export const readAssociations = async (
  ctx: AccountContext,
  entity: EntityRef,
  options: { q?: string | undefined; sort?: AssociationSort | undefined } = {},
): Promise<AssociationRail> =>
  withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const { entityType, entityId } = entity
    const self = objectOrThrow(registry, entityType)
    const needle = options.q?.trim().toLowerCase()
    const sort = options.sort ?? 'recent'

    const totals = new Map<string, number>()
    const own = new Map<string, AssociatedRecord[]>()
    const linked = new Map<string, AssociatedRecord[]>()
    const push = (map: Map<string, AssociatedRecord[]>, key: string, record: AssociatedRecord) =>
      map.set(key, [...(map.get(key) ?? []), record])
    const add = (key: string, n: number) => totals.set(key, (totals.get(key) ?? 0) + n)

    const objectFor = (key: string): RegistryObject | undefined => registry.byKey.get(key)

    // Applied in SQL for the reads that are capped, so searching a company with
    // four hundred contacts looks at all of them rather than at whichever hundred
    // the cap happened to load.
    const matching = (expression: string) =>
      needle ? sql`and lower(${sql.raw(expression)}) like ${`%${needle}%`}` : sql``
    const orderedBy = (expression: string) =>
      sort === 'name' ? sql`order by ${sql.raw(expression)} asc nulls last` : sql`order by created_at desc`

    // The relationship a record stores on itself. Only the core three have one:
    // a custom record's every value is in its blob, and none of them is a
    // foreign key.
    if (entityType === 'contact' || entityType === 'deal') {
      const [row] = await tx.execute<{ company_id: string | null }>(
        sql`select company_id from ${sql.raw(`"${entityType}"`)} where id = ${entityId} limit 1`,
      )
      const companyObject = objectFor('company')
      if (row?.company_id && companyObject) {
        add('company', 1)
        const company = (await fetchByIds(tx, companyObject, [row.company_id])).get(row.company_id)
        // No label: isPrimary already renders the "Primary" badge, and setting both
        // printed the word twice on the same row.
        if (company && keeps(company, needle)) push(own, 'company', toRecord(companyObject, company, 'primary', null))
      }
    }

    if (entityType === 'company') {
      const contactObject = objectFor('contact')
      const dealObject = objectFor('deal')
      const contactName = `coalesce(nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''), email, '')`
      if (contactObject) {
        const contacts = await tx.execute<Row>(sql`
          select ${nameSelect(contactObject)} from contact
           where company_id = ${entityId} and deleted_at is null ${matching(contactName)}
           ${orderedBy(contactName)} limit 100`)
        for (const row of contacts) push(own, 'contact', toRecord(contactObject, row, 'own', null))
      }
      if (dealObject) {
        const deals = await tx.execute<Row>(sql`
          select ${nameSelect(dealObject)} from deal
           where company_id = ${entityId} and deleted_at is null ${matching(`coalesce(name, '')`)}
           ${orderedBy('name')} limit 100`)
        for (const row of deals) push(own, 'deal', toRecord(dealObject, row, 'own', null))
      }

      // Its own query, because both the cap and the search narrow the two above.
      const [counted] = await tx.execute<{ contacts: number; deals: number }>(sql`
        select (select count(*)::int from contact where company_id = ${entityId} and deleted_at is null) as contacts,
               (select count(*)::int from deal where company_id = ${entityId} and deleted_at is null) as deals`)
      add('contact', counted?.contacts ?? 0)
      add('deal', counted?.deals ?? 0)
    }

    // Rows in the association table, in both directions. Never capped, so these
    // are counted and narrowed here rather than in SQL.
    const links = await tx.execute<{ other_type: EntityType; other_id: string; label: string | null }>(sql`
      select to_type as other_type, to_id as other_id, label from association
       where from_type = ${entityType} and from_id = ${entityId}
      union all
      select from_type as other_type, from_id as other_id, label from association
       where to_type = ${entityType} and to_id = ${entityId}`)

    const grouped = new Map<string, string[]>()
    for (const link of links) {
      grouped.set(link.other_type, [...(grouped.get(link.other_type) ?? []), link.other_id])
    }

    for (const [objectKey, ids] of grouped) {
      // An object deleted since the link was written. The row is orphaned and
      // there is nothing to name, so it is not counted rather than drawn blank.
      const object = objectFor(objectKey)
      if (!object) continue
      const found = await fetchByIds(tx, object, ids)
      const seen = new Set((own.get(objectKey) ?? []).map((record) => record.id))
      for (const id of ids) {
        const row = found.get(id)
        if (!row || seen.has(id)) continue
        seen.add(id)
        add(objectKey, 1)
        if (!keeps(row, needle)) continue
        const label = links.find((link) => link.other_id === id)?.label ?? null
        push(linked, objectKey, toRecord(object, row, 'linked', label))
      }
    }

    const order = (records: AssociatedRecord[]): AssociatedRecord[] =>
      [...records].sort((a, b) =>
        sort === 'name'
          ? a.displayName.localeCompare(b.displayName)
          : (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
      )

    // A card for everything that can be linked from here, plus this record's own
    // object when something of it is linked, in registry order.
    const groups = registry.objects.flatMap((object): AssociationGroup[] => {
      // What the record holds itself comes first: a contact's own company is the
      // primary one, and a company's own contacts are the ones that belong to it.
      const records = [...(own.get(object.key) ?? []), ...order(linked.get(object.key) ?? [])]
      if (object.key === self.key && records.length === 0) return []
      return [
        {
          objectKey: object.key,
          nameSingular: object.nameSingular,
          namePlural: object.namePlural,
          records,
          total: totals.get(object.key) ?? 0,
        },
      ]
    })

    return { groups }
  })

const keeps = (row: Row, needle: string | undefined): boolean =>
  !needle ||
  (row.name ?? '').toLowerCase().includes(needle) ||
  (row.detail ?? '').toLowerCase().includes(needle)

const nameOf = async (tx: Tx, registry: Registry, ref: EntityRef): Promise<string> => {
  const object = registry.byKey.get(ref.entityType)
  if (!object) return 'a deleted record'
  const [row] = await tx.execute<Row>(sql`
    select ${nameSelect(object)} from ${tableFor(object)}
     where id = ${ref.entityId} and ${rowsOf(object)} limit 1`)
  return row?.name ?? 'a deleted record'
}

/** Stored once, in a stable direction, so the same pair cannot exist twice under
 *  two orderings. Exported because the importer writes association rows straight
 *  rather than through `associate`, and a second definition of this is a second
 *  ordering. */
export const orderedPair = (a: EntityRef, b: EntityRef): [EntityRef, EntityRef] =>
  a.entityType < b.entityType || (a.entityType === b.entityType && a.entityId < b.entityId) ? [a, b] : [b, a]

export const associate = async (
  ctx: AccountContext,
  a: EntityRef,
  b: EntityRef,
  label?: string | null,
): Promise<void> =>
  mutate(ctx, 'association', async (tx) => {
    if (a.entityType === b.entityType && a.entityId === b.entityId) {
      throw new Error('A record cannot be associated with itself.')
    }
    // Both keys resolved before anything is written: the column is text now, and
    // the registry is what says a key names an object in this account.
    const registry = await getRegistryIn(tx)
    objectOrThrow(registry, a.entityType)
    objectOrThrow(registry, b.entityType)

    const [from, to] = orderedPair(a, b)
    await tx.execute(sql`
      insert into association (account_id, from_type, from_id, to_type, to_id, label)
      values (${ctx.accountId}, ${from.entityType}, ${from.entityId}, ${to.entityType}, ${to.entityId}, ${label ?? null})
      on conflict (account_id, from_type, from_id, to_type, to_id) do update set label = excluded.label`)

    const [fromName, toName] = await Promise.all([nameOf(tx, registry, from), nameOf(tx, registry, to)])
    await recordActivity(tx, ctx, {
      type: 'association_change',
      subject: `linked ${fromName} to ${toName}`,
      payload: { from, to, label: label ?? null },
      links: [from, to],
    })

    return {
      result: undefined,
      audit: { entity: 'association', entityId: to.entityId, action: 'associate', before: null, after: { from, to, label } },
    }
  })

export const dissociate = async (ctx: AccountContext, a: EntityRef, b: EntityRef): Promise<void> =>
  mutate(ctx, 'association', async (tx) => {
    const [from, to] = orderedPair(a, b)
    const removed = await tx.execute(sql`
      delete from association
       where from_type = ${from.entityType} and from_id = ${from.entityId}
         and to_type = ${to.entityType} and to_id = ${to.entityId}
      returning to_id`)

    if (removed.length === 0) throw new Error('Those records are not associated.')

    const registry = await getRegistryIn(tx)
    const [fromName, toName] = await Promise.all([nameOf(tx, registry, from), nameOf(tx, registry, to)])
    await recordActivity(tx, ctx, {
      type: 'association_change',
      subject: `unlinked ${fromName} from ${toName}`,
      payload: { from, to },
      links: [from, to],
    })

    return {
      result: undefined,
      audit: { entity: 'association', entityId: to.entityId, action: 'dissociate', before: { from, to }, after: null },
    }
  })
