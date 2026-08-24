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

/** Transaction-mode pooler. Prepared statements do not survive it, hence prepare: false. */
const appClient = postgres(required('DATABASE_URL'), {
  prepare: false,
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  idle_timeout: 20,
  connect_timeout: 10,
})

export const appDb = drizzle(appClient, { schema })

/** Session-mode pooler as the table owner. Migrations and the tenancy DDL only.
 *  This role has BYPASSRLS, so nothing that serves a request may use it. */
export const ownerClient = () =>
  postgres(required('DATABASE_URL_OWNER'), { max: 1, onnotice: () => {} })

export const closeAppPool = () => appClient.end({ timeout: 5 })
