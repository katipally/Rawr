import { dropIndexSql, isPermanentSqlError, planFieldIndex, type FieldType } from '@rawr/db'
import { z } from 'zod'
import { owner, recordDeadLetter } from '../db.ts'
import { basePayload, defineJob } from './registry.ts'

const payload = basePayload.extend({
  fieldIndexId: z.uuid(),
  fieldId: z.uuid(),
})

/** The only place in the system that emits DDL. It reads what to build from the
 *  field's own rows rather than trusting the payload, and the statement comes from
 *  `planFieldIndex`, which builds it only from validated keys and ids.
 *
 *  A refusal that can never change (a type that cannot be indexed, a statement
 *  Postgres rejects as written) ends the row as 'failed' with its reason and does
 *  not retry. Anything else is retried by the queue. */
export const createFieldIndex = defineJob({
  name: 'field-index.create',
  schema: payload,
  retryLimit: 5,
  retryDelaySeconds: 30,
  handle: async ({ accountId, fieldIndexId, fieldId }) => {
    const [row] = await owner`
      select f.key as field_key, f.type as field_type, o.key as object_key,
             o.id as object_id, o.is_custom
        from field_index fi
        join field_def f on f.id = fi.field_id and f.deleted_at is null
        join object_def o on o.id = f.object_id
       where fi.id = ${fieldIndexId} and fi.account_id = ${accountId}`
    // Deleted since it was queued; the sweep in the dispatcher drops what it built.
    if (!row) return

    const fail = (message: string) => owner`
      update field_index set state = 'failed', last_error = ${message}
       where id = ${fieldIndexId} and account_id = ${accountId}`
    const failForGood = async (message: string) => {
      await fail(message)
      await recordDeadLetter({
        accountId,
        jobName: 'field-index.create',
        payload: { accountId, fieldIndexId, fieldId },
        error: message,
        attempts: 0,
      })
    }

    let plan: ReturnType<typeof planFieldIndex>
    try {
      plan = planFieldIndex({
        fieldId,
        fieldKey: row.field_key as string,
        fieldType: row.field_type as FieldType,
        objectKey: row.object_key as string,
        objectId: row.object_id as string,
        isCustomObject: row.is_custom as boolean,
      })
    } catch (cause) {
      await failForGood(cause instanceof Error ? cause.message : String(cause))
      return
    }

    // The row is the record the sweep trusts, so it names the index before the
    // index exists. A row from before names were per field is brought in line here.
    await owner`
      update field_index set pg_index_name = ${plan.name}
       where id = ${fieldIndexId} and account_id = ${accountId} and pg_index_name <> ${plan.name}`

    // A failed CREATE INDEX CONCURRENTLY leaves the index behind marked invalid,
    // and IF NOT EXISTS then matches it on the retry and does nothing at all, so
    // the row would flip to 'ready' over an index the planner refuses to use.
    // Dropping any invalid leftover first is what makes the retry mean something.
    const [invalid] = await owner`
      select 1 from pg_class c
        join pg_index i on i.indexrelid = c.oid
       where c.relname = ${plan.name} and not i.indisvalid`
    if (invalid) await owner.unsafe(dropIndexSql(plan.name))

    try {
      // CONCURRENTLY cannot run inside a transaction, which is exactly why this is
      // a job and not part of the request that asked for it.
      await owner.unsafe(plan.create)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (isPermanentSqlError(cause)) {
        await failForGood(message)
        return
      }
      await fail(message)
      throw cause
    }

    await owner`
      update field_index set state = 'ready', last_error = null
       where id = ${fieldIndexId} and account_id = ${accountId}`
  },
})
