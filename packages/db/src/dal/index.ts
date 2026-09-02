import { AsyncLocalStorage } from 'node:async_hooks'
import { sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import { auditLog } from '../schema/identity.ts'
import { assertCanWrite, type WorkspaceContext } from './context.ts'

export * from './context.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Tx = Parameters<Parameters<typeof appDb.transaction>[0]>[0]

/** An open transaction with its workspace already pinned, offered to any nested
 *  call for the same workspace. Keyed by workspace id and checked on every join,
 *  so a call for a different tenant can never land on a handle pinned to this one. */
const ambient = new AsyncLocalStorage<{ workspaceId: string; tx: Tx }>()

const open = async <T>(ctx: WorkspaceContext, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  appDb.transaction(async (tx) => {
    // set_config rather than SET LOCAL: the value is a bind parameter, so a
    // workspace id can never be concatenated into SQL. Third argument is is_local.
    await tx.execute(sql`select set_config('rawr.workspace_id', ${ctx.workspaceId}, true)`)
    return ambient.run({ workspaceId: ctx.workspaceId, tx }, () => fn(tx))
  })

const assertUsable = (ctx: WorkspaceContext): void => {
  if (!UUID.test(ctx.workspaceId)) {
    throw new Error(`Refusing to open a transaction: "${ctx.workspaceId}" is not a workspace id.`)
  }
}

/** The only way into the database. Pins the workspace for the transaction's
 *  lifetime, then hands the caller a scoped handle. A query that escapes this and
 *  forgets its filter returns zero rows, because the row level security policy has
 *  no workspace to compare against.
 *
 *  Joins a transaction already open for the same workspace rather than opening a
 *  second one. BEGIN, the set_config and COMMIT are each a network round trip, so
 *  six reads on one screen cost eighteen round trips of pure overhead before a
 *  single row is fetched. Nothing about the isolation changes: the join is only
 *  ever onto a handle whose workspace is already the one being asked for. */
export const withWorkspace = async <T>(
  ctx: WorkspaceContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> => {
  assertUsable(ctx)
  const current = ambient.getStore()
  if (current && current.workspaceId === ctx.workspaceId) return fn(current.tx)
  return open(ctx, fn)
}

/** Opens one transaction for a group of reads that would otherwise open one each.
 *  A page with six reads becomes one BEGIN and one COMMIT.
 *
 *  Explicit rather than automatic: the transaction holds a pooler connection for
 *  as long as the callback runs, so the caller is the one who decides that its
 *  work is short, bounded, and worth the connection. Wrap reads that feed one
 *  screen; never wrap a render that awaits anything but the database. */
export const withWorkspaceReads = async <T>(
  ctx: WorkspaceContext,
  fn: () => Promise<T>,
): Promise<T> => {
  assertUsable(ctx)
  if (ambient.getStore()?.workspaceId === ctx.workspaceId) return fn()
  return open(ctx, () => fn())
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
