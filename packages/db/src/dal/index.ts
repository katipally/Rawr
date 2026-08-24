import { sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import { auditLog } from '../schema/identity.ts'
import { assertCanWrite, type WorkspaceContext } from './context.ts'

export * from './context.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Tx = Parameters<Parameters<typeof appDb.transaction>[0]>[0]

/** The only way into the database. Opens a transaction, pins the workspace for its
 *  lifetime, then hands the caller a scoped handle. A query that escapes this and
 *  forgets its filter returns zero rows, because the row level security policy has
 *  no workspace to compare against. */
export const withWorkspace = async <T>(
  ctx: WorkspaceContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> => {
  if (!UUID.test(ctx.workspaceId)) {
    throw new Error(`Refusing to open a transaction: "${ctx.workspaceId}" is not a workspace id.`)
  }
  return appDb.transaction(async (tx) => {
    // set_config rather than SET LOCAL: the value is a bind parameter, so a
    // workspace id can never be concatenated into SQL. Third argument is is_local.
    await tx.execute(sql`select set_config('rawr.workspace_id', ${ctx.workspaceId}, true)`)
    return fn(tx)
  })
}

export type AuditEntry = {
  entity: string
  entityId: string | null
  action: string
  before?: unknown
  after?: unknown
}

/** Every mutation writes one of these, inside the same transaction as the change,
 *  so a committed change without its audit row is not reachable. */
export const writeAudit = async (
  tx: Tx,
  ctx: WorkspaceContext,
  entry: AuditEntry,
): Promise<void> => {
  await tx.insert(auditLog).values({
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    actorKind: ctx.actorKind,
    entity: entry.entity,
    entityId: entry.entityId,
    action: entry.action,
    before: entry.before ?? null,
    after: entry.after ?? null,
  })
}

/** Guard, mutate, audit, in one place so no caller can do two of the three. */
export const mutate = async <T>(
  ctx: WorkspaceContext,
  entity: string,
  fn: (tx: Tx) => Promise<{ result: T; audit: AuditEntry }>,
): Promise<T> => {
  assertCanWrite(ctx, entity)
  return withWorkspace(ctx, async (tx) => {
    const { result, audit } = await fn(tx)
    await writeAudit(tx, ctx, audit)
    return result
  })
}
