import { AsyncLocalStorage } from 'node:async_hooks'
import { sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import { auditLog } from '../schema/identity.ts'
import { assertCanWrite, type AccountContext } from './context.ts'

export * from './context.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A record id from a URL or an assistant is text until proven otherwise. Readers
 *  check it before querying, because Postgres answers a malformed uuid with a cast
 *  error, and that is a broken screen where "not here" is the truth. */
export const isUuid = (value: string): boolean => UUID.test(value)

export type Tx = Parameters<Parameters<typeof appDb.transaction>[0]>[0]

/** An open transaction with its account already pinned, offered to any nested
 *  call for the same account. Keyed by account id and checked on every join,
 *  so a call for a different tenant can never land on a handle pinned to this one. */
const ambient = new AsyncLocalStorage<{ accountId: string; tx: Tx }>()

const open = async <T>(ctx: AccountContext, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  appDb.transaction(async (tx) => {
    // The id is inlined as a literal rather than bound: assertUsable has already
    // proven it is a bare UUID, and a statement with no parameters is one round
    // trip where a bound one is two (the driver describes before it binds).
    await tx.execute(sql`select set_config('rawr.account_id', ${sql.raw(`'${ctx.accountId}'`)}, true)`)
    return ambient.run({ accountId: ctx.accountId, tx }, () => fn(tx))
  })

const assertUsable = (ctx: AccountContext): void => {
  if (!UUID.test(ctx.accountId)) {
    throw new Error(`Refusing to open a transaction: "${ctx.accountId}" is not a account id.`)
  }
}

/** The only way into the database. Pins the account for the transaction's
 *  lifetime, then hands the caller a scoped handle. A query that escapes this and
 *  forgets its filter returns zero rows, because the row level security policy has
 *  no account to compare against.
 *
 *  Joins a transaction already open for the same account rather than opening a
 *  second one. BEGIN, the set_config and COMMIT are each a network round trip, so
 *  six reads on one screen cost eighteen round trips of pure overhead before a
 *  single row is fetched. Nothing about the isolation changes: the join is only
 *  ever onto a handle whose account is already the one being asked for. */
export const withAccount = async <T>(
  ctx: AccountContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> => {
  assertUsable(ctx)
  const current = ambient.getStore()
  if (current && current.accountId === ctx.accountId) return fn(current.tx)
  return open(ctx, fn)
}

/** A group of reads that feed one screen. Each read still opens its own
 *  transaction, on its own pooled connection, and that is deliberate: the driver
 *  runs parameterised statements on one connection strictly one at a time, two
 *  round trips each, so pinning a fan-out of N reads to one transaction costs 2N
 *  trips in a row. Spread across the pool the same fan-out costs about five.
 *  Measured on the record page: 3.0 s pinned, under 1 s spread.
 *
 *  Kept as the one place a page names its read set, so the day the driver
 *  pipelines this is one function to change. */
export const withAccountReads = async <T>(ctx: AccountContext, fn: () => Promise<T>): Promise<T> => {
  assertUsable(ctx)
  return fn()
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
  ctx: AccountContext,
  entry: AuditEntry,
): Promise<void> => {
  await tx.insert(auditLog).values({
    accountId: ctx.accountId,
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
  ctx: AccountContext,
  entity: string,
  fn: (tx: Tx) => Promise<{ result: T; audit: AuditEntry }>,
): Promise<T> => {
  assertCanWrite(ctx, entity)
  return withAccount(ctx, async (tx) => {
    const { result, audit } = await fn(tx)
    await writeAudit(tx, ctx, audit)
    return result
  })
}
