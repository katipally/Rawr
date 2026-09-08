import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '../schema/index.ts'

/** Not reachable from outside this package: the exports map in package.json
 *  publishes "." and "./schema" only, so no app can import a raw pool even by
 *  accident. Everything goes through the data access layer. */

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill in the database URLs.`,
    )
  }
  return value
}

/** Opened on first use, not at import: a build renders pages that reach this
 *  module and never touch the database, and connecting at module scope made
 *  `next build` fail on every machine that is not also a deploy. */
let opened: { client: ReturnType<typeof postgres>; db: ReturnType<typeof connect>['db'] } | null = null

const connect = () => {
  const client = postgres(required('DATABASE_URL'), {
    // Prepared statements do not survive a transaction pooler (Supavisor, PgBouncer,
    // RDS Proxy). Set DATABASE_PREPARED=1 when connecting straight to Postgres.
    prepare: process.env.DATABASE_PREPARED === '1',
    // A record screen fans out to about fifteen reads, each on its own connection.
    max: Number(process.env.DATABASE_POOL_MAX ?? 20),
    // A fresh connection costs a TLS handshake, so dropping one after twenty idle
    // seconds made every click after a pause pay it again.
    idle_timeout: Number(process.env.DATABASE_IDLE_TIMEOUT ?? 600),
    max_lifetime: 60 * 60,
    connect_timeout: 10,
  })
  return { client, db: drizzle(client, { schema }) }
}

const pool = () => {
  if (!opened) opened = connect()
  return opened
}

/** The same object every call site already had, one property access later. A
 *  Proxy rather than a function, so nothing above this file has to know that the
 *  connection is deferred. */
export const appDb = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get: (_target, property) => {
    const db = pool().db
    return Reflect.get(db, property, db)
  },
})

/** The table owner. Migrations and tenancy DDL only: it bypasses RLS, so nothing
 *  that serves a request may use it. */
export const closeAppPool = async () => {
  const open = opened
  opened = null
  if (open) await open.client.end({ timeout: 5 })
}
