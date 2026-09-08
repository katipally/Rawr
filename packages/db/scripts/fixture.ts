import { sql } from 'drizzle-orm'
import { withAccount } from '../src/dal/index.ts'

/** The tenants the seed builds and the verify suites read.
 *
 *  They are deliberately not a real company. The seed empties its accounts by
 *  slug before rebuilding them, so anything sharing a slug with a fixture is
 *  destroyed on the next `pnpm db:seed`; keeping the fixtures on reserved `.test`
 *  domains is what stops that reaching an account somebody actually uses.
 *
 *  Two of them, because tenancy is only provable against a second tenant. */
export const SANDBOX = { name: 'Sandbox', slug: 'sandbox', domain: 'sandbox.test' } as const
export const PEER = { name: 'Peer Tenant', slug: 'peer', domain: 'peer.test' } as const

/** A seeded seat's address. The local parts are the shapes of access the seed
 *  builds: `admin`, `sales`, `marketing`, `viewer`, `former`. */
export const seat = (who: string): string => `${who}@${SANDBOX.domain}`

/** The account's own super admin, for a suite context that writes.
 *
 *  A suite calling itself `actorKind: 'user'` with `actorId: null` is a person
 *  nobody can name, and every write it makes stamps audit_log with one. That is
 *  what verify-account refuses — and because account runs first, the suite that
 *  caused the row always passed while the next run of the other one failed.
 *
 *  Read inside the account scope, because membership is tenant-scoped and the
 *  bare pool has no account pinned: unscoped it returns nothing at all. */
export const seatFor = async (accountId: string, slug: string): Promise<string> => {
  const [seat] = await withAccount(
    { accountId, actorId: null, actorKind: 'job', isSuperAdmin: false, viewHubs: [], editHubs: [] },
    (tx) =>
      tx.execute<{ id: string }>(
        sql`select m.user_id as id from membership m
             where m.is_super_admin and m.deactivated_at is null
             order by m.created_at limit 1`,
      ) as Promise<{ id: string }[]>,
  )
  if (!seat) throw new Error(`account ${slug} has no super admin seated. Run pnpm db:seed.`)
  return seat.id
}
