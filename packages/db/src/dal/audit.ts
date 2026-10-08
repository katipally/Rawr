import { sql } from 'drizzle-orm'
import { isAdmin, type AccountContext } from './context.ts'
import { AUDIT_TARGETS, type AuditTarget } from './audit-targets.ts'
import { withAccount, type Tx } from './index.ts'
import { getRegistryIn, rowsOf, tableFor } from './registry.ts'

/** The account's own history: who changed what, and when. Append-only by grant,
 *  so this is a reader and there is deliberately no writer here; `mutate` is the
 *  only thing that writes an audit row.
 *
 *  Keyset paged on (at desc, id desc) over `audit_log_entity_idx`, so page fifty
 *  costs the same as page one. O(page), never O(offset). */

export type AuditRow = {
  id: string
  at: Date
  actorId: string | null
  actorName: string | null
  actorKind: string
  entity: string
  entityId: string | null
  action: string
  before: unknown
  after: unknown
  /** The name of what the row is about, read live from its current row, or from the
   *  snapshot when that row is gone. Null when neither has a name. */
  targetName: string | null
}

export type AuditPage = { rows: AuditRow[]; cursor: { at: string; id: string } | null }

type RawRow = {
  id: string
  at: Date
  actor_id: string | null
  actor_name: string | null
  actor_kind: string
  entity: string
  entity_id: string | null
  action: string
  before: unknown
  after: unknown
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** The entity whose record a row is about. An association row is about the record it
 *  links to, which it keeps under `to`, or under `target` for a bulk link. */
const targetTypeOf = (row: RawRow): string | null => {
  if (row.entity !== 'association') return row.entity
  const link = asRecord(asRecord(row.after).to ?? asRecord(row.after).target ?? asRecord(row.before).to)
  return typeof link.entityType === 'string' ? link.entityType : null
}

/** The record's name as it stood when the row was written, for a record that is gone.
 *  The after is newer than the before, so it wins where both have one. */
const snapshotName = (row: RawRow, key: string): string | null => {
  for (const value of [row.after, row.before]) {
    const name = asRecord(value)[key]
    if (typeof name === 'string' && name.trim() !== '') return name
  }
  return null
}

/** Own keys only: a custom object can be keyed `constructor`, which a plain lookup would
 *  answer with a prototype member. */
const targetOf = (type: string): AuditTarget | undefined =>
  Object.hasOwn(AUDIT_TARGETS, type) ? AUDIT_TARGETS[type] : undefined

/** Names for one entity's records, keyed by id, one query per entity. Entities that
 *  are not in the target table are custom objects, read through the registry. */
const namesOf = async (tx: Tx, type: string, ids: string[]): Promise<Map<string, string | null>> => {
  const list = `{${ids.join(',')}}`
  const target = targetOf(type)
  if (target === 'link' || target === null) return new Map()
  if (target) {
    const rows = await tx.execute<{ id: string; name: string | null }>(sql`
      select t.id, ${sql.raw(target.name)} as name
        from ${sql.raw(target.from)}
       where t.id = any(${list}::uuid[])`)
    return new Map(rows.map((row) => [row.id, row.name]))
  }
  const object = (await getRegistryIn(tx)).byKey.get(type)
  if (!object?.isCustom || !object.labelFieldKey) return new Map()
  const rows = await tx.execute<{ id: string; name: string | null }>(sql`
    select id, nullif(trim(custom ->> ${object.labelFieldKey}), '') as name
      from ${tableFor(object)}
     where ${rowsOf(object)} and id = any(${list}::uuid[])`)
  return new Map(rows.map((row) => [row.id, row.name]))
}

/** One name per row, in row order. The rows are grouped by entity first, so a page costs
 *  one query for each entity it touches, however many rows each of those has. */
const targetNames = async (tx: Tx, rows: RawRow[]): Promise<(string | null)[]> => {
  const idsByType = new Map<string, Set<string>>()
  for (const row of rows) {
    const type = targetTypeOf(row)
    if (type === null || row.entity_id === null) continue
    const ids = idsByType.get(type) ?? new Set<string>()
    idsByType.set(type, ids.add(row.entity_id))
  }

  const live = new Map<string, string | null>()
  for (const [type, ids] of idsByType) {
    for (const [id, name] of await namesOf(tx, type, [...ids])) live.set(`${type}:${id}`, name)
  }

  return rows.map((row) => {
    const type = targetTypeOf(row)
    if (type === null || row.entity_id === null) return null
    const target = targetOf(type)
    const snapshotKey = target === undefined ? 'name' : target === null || target === 'link' ? null : (target.snapshot ?? null)
    return live.get(`${type}:${row.entity_id}`) ?? (snapshotKey ? snapshotName(row, snapshotKey) : null)
  })
}

export const listAudit = async (
  ctx: AccountContext,
  input: {
    entity?: string | null | undefined
    actorId?: string | null | undefined
    from?: string | null | undefined
    to?: string | null | undefined
    limit?: number | undefined
    cursor?: { at: string; id: string } | null | undefined
  } = {},
): Promise<AuditPage> =>
  withAccount(ctx, async (tx) => {
    if (!isAdmin(ctx)) {
      throw new Error('Only an admin can read the account history.')
    }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
    const rows = await tx.execute<RawRow>(sql`
      select a.id, a.at, a.actor_id, u.name as actor_name, a.actor_kind,
             a.entity, a.entity_id, a.action, a.before, a.after
        from audit_log a
        left join user_account u on u.id = a.actor_id
       where (${input.entity ?? null}::text is null or a.entity = ${input.entity ?? null})
         and (${input.actorId ?? null}::uuid is null or a.actor_id = ${input.actorId ?? null}::uuid)
         and (${input.from ?? null}::timestamptz is null or a.at >= ${input.from ?? null}::timestamptz)
         and (${input.to ?? null}::timestamptz is null or a.at < ${input.to ?? null}::timestamptz)
         and (
           ${input.cursor?.at ?? null}::timestamptz is null
           or (a.at, a.id) < (${input.cursor?.at ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid)
         )
       order by a.at desc, a.id desc
       limit ${limit + 1}
    `)

    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    const names = await targetNames(tx, page)
    return {
      rows: page.map((row, index) => ({
        id: row.id,
        at: new Date(row.at),
        actorId: row.actor_id,
        actorName: row.actor_name,
        actorKind: row.actor_kind,
        entity: row.entity,
        entityId: row.entity_id,
        action: row.action,
        before: row.before,
        after: row.after,
        targetName: names[index] ?? null,
      })),
      cursor: rows.length > limit && last ? { at: new Date(last.at).toISOString(), id: last.id } : null,
    }
  })

/** Which entities actually appear, so the filter offers real values rather than a
 *  hardcoded list that drifts from the role matrix. */
export const auditEntities = async (ctx: AccountContext): Promise<string[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{ entity: string }>(
      sql`select distinct entity from audit_log order by entity`,
    )
    return rows.map((row) => row.entity)
  })
