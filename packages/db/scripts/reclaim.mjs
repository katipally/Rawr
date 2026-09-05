import postgres from 'postgres'

/** Returns the disk the scale suite borrowed.
 *
 *  `pnpm db:verify:scale` writes and then deletes several hundred thousand rows.
 *  Deleted rows are still on disk until a vacuum, and a plain vacuum returns the
 *  space to the table rather than to the filesystem, so a few runs in an
 *  afternoon can fill a small Supabase project and put it into read-only mode.
 *  This is the way out: full vacuum, which rewrites each table and gives the
 *  space back.
 *
 *  Not part of the suite. It takes an exclusive lock on every table it touches,
 *  which is fine on a development database and is not something a script should
 *  do to a shared one on its own initiative. */

const p = postgres(process.env.DATABASE_URL_OWNER, { max: 1, onnotice: () => {} })

try {
  // A project that has hit its quota refuses writes, including the vacuum that
  // would fix it. The owner may lift it for its own session.
  await p`set default_transaction_read_only = off`
  await p`set statement_timeout = 0`

  const [before] = await p`select pg_size_pretty(pg_database_size(current_database())) as size`
  console.log(`database ${before.size}`)

  for (const table of ['activity_link', 'activity', 'contact', 'company', 'segment_membership']) {
    await p.unsafe(`vacuum full analyze ${table}`)
    console.log(`  rewrote ${table}`)
  }

  const [after] = await p`select pg_size_pretty(pg_database_size(current_database())) as size`
  console.log(`database ${after.size}`)
} finally {
  await p.end()
}
