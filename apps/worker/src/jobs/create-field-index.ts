import { assertUsableFieldKey } from '@rawr/db'
import { z } from 'zod'
import { owner } from '../db.ts'
import { basePayload, defineJob } from './registry.ts'

const payload = basePayload.extend({
  fieldIndexId: z.uuid(),
  objectKey: z.enum(['company', 'contact', 'deal']),
  fieldKey: z.string(),
})

/** The only place in the system that emits DDL. Identifiers come from field_def
 *  after validation and are quoted by format(%I); no user text is ever
 *  concatenated into SQL here.
 *
 *  The expression matches what the query builder emits for a jsonb field, or the
 *  index will be built and never used. */
export const createFieldIndex = defineJob({
  name: 'field-index.create',
  schema: payload,
  retryLimit: 5,
  retryDelaySeconds: 30,
  handle: async ({ accountId, fieldIndexId, objectKey, fieldKey }) => {
    assertUsableFieldKey(fieldKey)
    assertUsableFieldKey(objectKey)
    const indexName = `hot_${objectKey}_${fieldKey}`

    // A failed CREATE INDEX CONCURRENTLY leaves the index behind marked invalid,
    // and IF NOT EXISTS then matches it on the retry and does nothing at all — so
    // the row would flip to 'ready' over an index the planner refuses to use.
    // Dropping any invalid leftover first is what makes the retry mean something.
    const [invalid] = await owner`
      select 1 from pg_class c
        join pg_index i on i.indexrelid = c.oid
       where c.relname = ${indexName} and not i.indisvalid`
    if (invalid) await owner.unsafe(`drop index concurrently if exists "${indexName}"`)

    try {
      // CONCURRENTLY cannot run inside a transaction, which is exactly why this is
      // a job and not part of the request that asked for it.
      // Every fragment below has passed FIELD_KEY or the object enum, so it is
      // drawn from [a-z0-9_] only. That charset cannot close a quote or an
      // identifier, which is what makes this the one safe place to build DDL as
      // text. CONCURRENTLY forbids a transaction, so a prepared statement or a
      // DO block is not an option.
      await owner.unsafe(
        `create index concurrently if not exists "${indexName}" on "${objectKey}" ` +
          `(((custom->>'${fieldKey}'))) where custom ? '${fieldKey}'`,
      )
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await owner`
        update field_index set state = 'failed', last_error = ${message}
         where id = ${fieldIndexId} and account_id = ${accountId}`
      throw cause
    }

    await owner`
      update field_index set state = 'ready', last_error = null
       where id = ${fieldIndexId} and account_id = ${accountId}`
  },
})
