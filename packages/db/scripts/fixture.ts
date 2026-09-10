import { sql } from 'drizzle-orm'
import postgres from 'postgres'
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

/** The account-scoped tables `pnpm db:seed` fills. Every other table carrying an
 *  `account_id` is residue once a suite has run, and `cleanup` empties it.
 *
 *  The list is a subtraction rather than an enumeration on purpose: a table added
 *  to the schema counts as residue until somebody puts it here, so forgetting one
 *  leaves the fixtures dirty and `verify-account` says so at the top of its next
 *  run. The other way round, forgetting would delete seeded rows the suites read
 *  back, and the failure would land in whichever suite ran next.
 *
 *  Cleanup is table-granular, so a suite that writes into one of these clears its
 *  own rows itself, the way verify-guards, verify-mcp, verify-objects and
 *  verify-scale already do. */
const SEEDED_TABLES = new Set([
  'activity',
  'activity_link',
  'association',
  'attachment',
  'automation',
  'availability',
  'booking',
  'booking_host',
  'booking_page',
  'calendar_grant',
  'company',
  'contact',
  'custom_record',
  'deal',
  'email_template',
  'field_def',
  'form',
  'form_submission',
  'import_row',
  'import_run',
  'integration',
  'invitation',
  'lifecycle_stage',
  'mailbox',
  'membership',
  'message',
  'message_body',
  'message_participant',
  'message_thread',
  'notification',
  'object_def',
  'page_view',
  'pipeline',
  'pipeline_stage',
  'report_dashboard',
  'saved_view',
  'segment',
  'segment_membership',
  'sequence',
  'sequence_enrollment',
  'sequence_step',
  'site',
  'subscription_state',
  'subscription_type',
  'task',
  'team',
  'team_member',
  'visitor',
  'visitor_alias',
  'visitor_session',
])

type Residue = { tables: string[]; accountIds: string[] }

/** The residue tables in delete order, plus the two fixture account ids.
 *
 *  Order comes from the live foreign key catalogue rather than a hand-kept list:
 *  a table is only deleted once nothing still standing points at it. Kahn over
 *  the residue subgraph, O(tables squared) on about thirty nodes. */
const residue = async (owner: postgres.Sql): Promise<Residue> => {
  const accounts = await owner<{ id: string; slug: string }[]>`
    select id, slug from account where slug in (${SANDBOX.slug}, ${PEER.slug})`
  if (accounts.length === 0) throw new Error('Neither fixture account exists. Run pnpm db:seed.')

  const scoped = await owner<{ name: string }[]>`
    select c.relname as name from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'account_id' and a.attnum > 0
     where c.relkind = 'r' and n.nspname = 'public'`
  const remaining = new Set(scoped.map((r) => r.name).filter((name) => !SEEDED_TABLES.has(name)))

  const edges = await owner<{ child: string; parent: string }[]>`
    select ct.relname as child, pt.relname as parent from pg_constraint c
      join pg_class ct on ct.oid = c.conrelid
      join pg_class pt on pt.oid = c.confrelid
     where c.contype = 'f' and ct.relname <> pt.relname`
  const children = new Map<string, Set<string>>()
  for (const { child, parent } of edges) {
    if (!remaining.has(child) || !remaining.has(parent)) continue
    const set = children.get(parent) ?? new Set<string>()
    set.add(child)
    children.set(parent, set)
  }

  const tables: string[] = []
  while (remaining.size > 0) {
    const free = [...remaining].filter((table) =>
      [...(children.get(table) ?? [])].every((child) => !remaining.has(child)),
    )
    // A reference cycle among residue tables would loop forever; deleting the rest
    // inside the one transaction still resolves it, or fails loudly saying which.
    if (free.length === 0) {
      tables.push(...remaining)
      break
    }
    for (const table of free) remaining.delete(table)
    tables.push(...free)
  }
  return { tables, accountIds: accounts.map((a) => a.id) }
}

/** Empties the residue tables in the two fixture accounts, in foreign key order.
 *
 *  Takes no account: the ids are read from the fixture slugs here, so no caller
 *  can point it at a tenant somebody uses. One transaction, so a suite that dies
 *  half way through leaves the fixtures either clean or untouched. */
export const cleanup = async (): Promise<void> => {
  const url = process.env.DATABASE_URL_OWNER
  if (!url) throw new Error('DATABASE_URL_OWNER is not set, so the fixtures cannot be emptied.')
  const owner = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const { tables, accountIds } = await residue(owner)
    await owner.begin(async (tx) => {
      for (const table of tables) {
        await tx`delete from ${tx(table)} where account_id = any(${accountIds})`
      }
    })
  } finally {
    await owner.end()
  }
}

/** What `cleanup` would delete, as a table-to-count list of what is actually there.
 *  Empty is the only correct answer at the top of a run. */
export const residueCounts = async (owner: postgres.Sql): Promise<Record<string, number>> => {
  const { tables, accountIds } = await residue(owner)
  const held: Record<string, number> = {}
  for (const table of tables) {
    const [row] = await owner<{ n: number }[]>`
      select count(*)::int as n from ${owner(table)} where account_id = any(${accountIds})`
    if (row && row.n > 0) held[table] = row.n
  }
  return held
}
