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
      `${name} is not set. Copy .env.example to .env.local and fill in the Supabase pooler URLs.`,
    )
  }
  return value
}

/** Transaction-mode pooler. Prepared statements do not survive it, hence prepare: false.
 *
 *  Opened on first use rather than at import. A build renders pages that import
 *  this module transitively and never touch the database, and connecting at
 *  module scope made `next build` fail on a machine that has no DATABASE_URL,
 *  which is every build machine that is not also a deploy. */
let opened: { client: ReturnType<typeof postgres>; db: ReturnType<typeof connect>['db'] } | null = null

const connect = () => {
  const client = postgres(required('DATABASE_URL'), {
    prepare: false,
    // A record screen fans out to about fifteen reads, each on its own connection.
    max: Number(process.env.DATABASE_POOL_MAX ?? 20),
    // A fresh connection to the pooler is a TLS handshake of roughly half a second,
    // so a connection dropped after twenty idle seconds made every click after a
    // pause pay it again. Ten minutes keeps a working session warm; the pooler
    // still reclaims anything left open overnight.
    idle_timeout: 600,
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

/** Session-mode pooler as the table owner. Migrations and the tenancy DDL only.
 *  This role has BYPASSRLS, so nothing that serves a request may use it. */
export const ownerClient = () =>
  postgres(required('DATABASE_URL_OWNER'), { max: 1, onnotice: () => {} })

export const closeAppPool = async () => {
  const open = opened
  opened = null
  if (open) await open.client.end({ timeout: 5 })
}
