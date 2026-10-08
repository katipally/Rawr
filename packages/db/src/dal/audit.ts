import { sql } from 'drizzle-orm'
import { isAdmin, type AccountContext } from './context.ts'
import { withAccount } from './index.ts'

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
  /** The name of what the row is about, read live from its current row. Null for an
   *  entity this does not resolve, or a row whose target has since been removed. */
  targetName: string | null
}

export type AuditPage = { rows: AuditRow[]; cursor: { at: string; id: string } | null }

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
    const rows = await tx.execute<{
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
      target_name: string | null
    }>(sql`
      select a.id, a.at, a.actor_id, u.name as actor_name, a.actor_kind,
             a.entity, a.entity_id, a.action, a.before, a.after,
             coalesce(
               member.name,
               t.name,
               nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
               co.name,
               d.name,
               case when a.entity = 'invitation' then coalesce(a.after ->> 'email', a.before ->> 'email') end
             ) as target_name
        from audit_log a
        left join user_account u on u.id = a.actor_id
        left join user_account member on a.entity = 'membership' and member.id = a.entity_id
        left join team t on a.entity = 'team' and t.id = a.entity_id
        left join contact c on a.entity = 'contact' and c.id = a.entity_id
        left join company co on a.entity = 'company' and co.id = a.entity_id
        left join deal d on a.entity = 'deal' and d.id = a.entity_id
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
    return {
      rows: page.map((row) => ({
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
        targetName: row.target_name,
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
