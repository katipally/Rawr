import { readFile } from 'node:fs/promises'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const url = process.env.DATABASE_URL_OWNER
if (!url) throw new Error('DATABASE_URL_OWNER is not set.')

// One connection as the table owner. Migrations only.
const client = postgres(url, { max: 1, onnotice: (notice) => console.log(notice.message) })
const db = drizzle(client)

try {
  // Ahead of the chain: 0003 creates an extension in the `extensions` schema and
  // 0004 alters the `rawr_app` role, so both have to exist before drizzle starts.
  const bootstrap = await readFile(new URL('../sql/bootstrap.sql', import.meta.url), 'utf8')
  // Passed as a parameter, never interpolated into the SQL. max:1, so the setting
  // and the script that reads it are on the same connection.
  await client`select set_config('rawr.app_password', ${process.env.APP_DB_PASSWORD ?? ''}, false)`
  await client.unsafe(bootstrap)
  await client`select set_config('rawr.app_password', '', false)`
  console.log('bootstrap applied.')

  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname })
  // Idempotent, and re-run after every migration so a table added today cannot
  // reach production without row level security on it.
  const [row] = await client`select rawr.apply_tenancy() as tables`
  console.log(`migrated. tenancy applied to ${row?.tables} tables.`)
} finally {
  await client.end()
}
