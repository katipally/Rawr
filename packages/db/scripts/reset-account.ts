import postgres from 'postgres'

/** Empties one account's CRM data and leaves the account itself set up.
 *
 *  For starting over: a botched migration, or a demo portal that is about to
 *  become the real one. What goes is the records and everything that describes
 *  what happened to them — contacts, companies, deals, the timeline, the audit
 *  trail, past import runs. What stays is everything somebody configured and
 *  would have to build again: the people and their seats, the pipeline and its
 *  stages, saved views, forms, sequences, automations, and the connections to
 *  Google and the mailboxes.
 *
 *  Tables are found by looking for an `account_id` column rather than from a
 *  list, so a table added later cannot be missed. They are emptied children
 *  first, following the foreign keys, so nothing has to be deferred or cascaded.
 *
 *  Nothing happens without `--confirm`. Without it this prints what it would
 *  empty and what it would leave, which is the only review there is: the delete
 *  itself cannot be undone.
 *
 *    node scripts/reset-account.ts --slug=datasaur
 *    node scripts/reset-account.ts --slug=datasaur --confirm
 */

/** Configuration, not data. Emptying any of these means somebody rebuilding it
 *  by hand, so they survive a reset. Everything else about the account goes —
 *  including a table added after this list was written, which is deliberate: the
 *  dry run prints every table it would empty, and a new one being listed there is
 *  a question a person can answer before confirming, where silently keeping it
 *  would leave data behind that nobody sees. */
const KEEP = new Set([
  // People, seats and teams
  'membership',
  'team',
  'team_member',
  'invitation',
  // The shape of a record. `field_def` is kept, but the properties an import
  // invented are dropped below: they were guessed from whatever file came first,
  // and a fresh import should read the whole of the next one rather than inherit
  // a type inferred from a hundred rows.
  'object_def',
  'field_def',
  'custom_event_def',
  // How deals move
  'pipeline',
  'pipeline_stage',
  'lifecycle_stage',
  // Saved work
  'saved_view',
  'segment',
  'report_dashboard',
  'email_template',
  // Definitions whose submissions and enrolments are data and do go
  'form',
  'form_folder',
  'booking_page',
  'booking_host',
  'availability',
  'availability_override',
  'sequence',
  'sequence_step',
  'automation',
  'site',
  'subscription_type',
  'webhook_endpoint',
  // Connections and credentials. Losing these means reconnecting Google.
  'integration',
  'mailbox',
  'calendar_grant',
  'mcp_oauth_code',
  'mcp_token',
])

const arg = (name: string): string | null => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : null
}

const slug = arg('slug')
const confirmed = process.argv.includes('--confirm')
if (!slug) throw new Error('Which account? Pass --slug=<account slug>.')

const url = process.env.DATABASE_URL_OWNER
if (!url) throw new Error('DATABASE_URL_OWNER is not set.')
const owner = postgres(url, { max: 1, onnotice: () => {} })

try {
  const [account] = await owner<{ id: string; name: string }[]>`
    select id, name from account where slug = ${slug}`
  if (!account) throw new Error(`No account has the slug "${slug}".`)

  const scoped = await owner<{ name: string }[]>`
    select c.relname as name from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'account_id' and a.attnum > 0
     where c.relkind = 'r' and n.nspname = 'public'`
  const remaining = new Set(scoped.map((row) => row.name).filter((name) => !KEEP.has(name)))

  // Children before parents, so a delete never trips a foreign key.
  const edges = await owner<{ child: string; parent: string }[]>`
    select ct.relname as child, pt.relname as parent from pg_constraint c
      join pg_class ct on ct.oid = c.conrelid
      join pg_class pt on pt.oid = c.confrelid
     where c.contype = 'f' and ct.relname <> pt.relname`
  const children = new Map<string, Set<string>>()
  for (const { child, parent } of edges) {
    if (!remaining.has(child) || !remaining.has(parent)) continue
    children.set(parent, (children.get(parent) ?? new Set()).add(child))
  }

  const ordered: string[] = []
  while (remaining.size > 0) {
    const free = [...remaining].filter((table) =>
      [...(children.get(table) ?? [])].every((child) => !remaining.has(child)),
    )
    // A cycle among them would loop for ever; taking the rest in any order is
    // still correct inside one transaction, which defers nothing but commits once.
    const next = free.length > 0 ? free : [...remaining]
    for (const table of next) {
      ordered.push(table)
      remaining.delete(table)
    }
  }

  const held: [string, number][] = []
  for (const table of ordered) {
    const [row] = await owner<{ n: number }[]>`
      select count(*)::int as n from ${owner(table)} where account_id = ${account.id}`
    if (row && row.n > 0) held.push([table, row.n])
  }
  const [invented] = await owner<{ n: number }[]>`
    select count(*)::int as n from field_def f
      join object_def o on o.id = f.object_id
     where o.account_id = ${account.id} and f.source = 'import' and f.deleted_at is null`

  console.log(`\n${account.name} (${slug})\n`)
  if (held.length === 0 && (invented?.n ?? 0) === 0) {
    console.log('  Nothing to empty.')
  } else {
    for (const [table, n] of held) console.log(`  ${table.padEnd(28)} ${String(n).padStart(9)}`)
    console.log(`\n  ${String(held.reduce((total, [, n]) => total + n, 0)).padStart(38)} rows`)
    console.log(`  properties an import invented ${String(invented?.n ?? 0).padStart(8)}  (dropped too)`)
  }
  console.log(`\n  kept: ${[...KEEP].sort().join(', ')}\n`)

  if (!confirmed) {
    console.log('  Nothing was changed. Add --confirm to empty it, which cannot be undone.\n')
  } else {
    await owner.begin(async (tx) => {
      for (const table of ordered) {
        await tx`delete from ${tx(table)} where account_id = ${account.id}`
      }
      await tx`
        delete from field_def f using object_def o
         where o.id = f.object_id and o.account_id = ${account.id} and f.source = 'import'`
    })
    console.log('  Emptied.\n')
  }
} finally {
  await owner.end()
}
