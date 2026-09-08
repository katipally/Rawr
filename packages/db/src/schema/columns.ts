import { sql } from 'drizzle-orm'
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core'

/** Postgres tsvector. Drizzle has no native mapping, and application code never
 *  reads the raw value, only matches against it. */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
})

/** A generated column, not a trigger, so the index physically cannot go stale.
 *  The 'simple' dictionary is deliberate: stemming mangles company and person
 *  names, which is almost everything we search. */
export const searchVector = (...cols: string[]) =>
  tsvector('search').generatedAlwaysAs(
    sql.raw(
      `to_tsvector('simple'::regconfig, ${cols.map((c) => `coalesce("${c}", '')`).join(" || ' ' || ")})`,
    ),
  )

export const pk = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`)

/** Present on every tenant table. Its presence is what makes the tenancy migration
 *  find the table, so it is never optional and never renamed. */
export const accountId = () => uuid('account_id').notNull()

export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
