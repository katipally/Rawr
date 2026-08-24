import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const url = process.env.DATABASE_URL_OWNER
if (!url) throw new Error('DATABASE_URL_OWNER is not set.')

// Session-mode pooler, one connection, as the table owner. Migrations only.
const client = postgres(url, { max: 1, onnotice: () => {} })
const db = drizzle(client)

try {
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname })
  // Idempotent, and re-run after every migration so a table added today cannot
  // reach production without row level security on it.
  const [row] = await client`select rawr.apply_tenancy() as tables`
  console.log(`migrated. tenancy applied to ${row?.tables} tables.`)
} finally {
  await client.end()
}
