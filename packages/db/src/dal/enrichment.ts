import { sql } from 'drizzle-orm'
import { enrichmentSuggestion } from '../schema/platform.ts'
import type { ObjectKey } from '../registry/core.ts'
import { recordActivity } from './activity.ts'
import type { AccountContext } from './context.ts'
import { assertCanWrite } from './context.ts'
import { withAccount, writeAudit, type Tx } from './index.ts'
import { recordFieldSource } from './integrations.ts'
import { assertCore, fieldOrThrow, getRegistryIn, objectOrThrow } from './registry.ts'
import { coerce } from './values.ts'

/** F6 §4. The rule, and the only place it lives:
 *
 *    enrichment NEVER overwrites a value a human entered.
 *    It fills blanks and updates values whose provenance is enrichment.
 *
 *  A refused value is not discarded. It becomes a suggestion visible on the record,
 *  because "we did not write this" and "we never saw this" are different things and
 *  only one of them lets a person decide. */

export type EnrichmentInput = {
  objectKey: ObjectKey
  entityId: string
  provider: string
  /** Field key to value, already in the shape the registry expects. */
  values: Record<string, unknown>
}

export type EnrichmentResult = {
  written: string[]
  suggested: string[]
  unchanged: string[]
  unknown: string[]
}

export const applyEnrichment = async (
  ctx: AccountContext,
  input: EnrichmentInput,
): Promise<EnrichmentResult> => {
  assertCanWrite(ctx, input.objectKey)

  return withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, input.objectKey)
    const table = sql.raw(`"${object.key}"`)

    const [current] = await tx.execute<Record<string, unknown>>(
      sql`select * from ${table} where id = ${input.entityId} and deleted_at is null limit 1`,
    )
    if (!current) throw new Error('That record no longer exists.')

    const sources = await tx.execute<{ field_key: string; source: string }>(
      sql`select field_key, source from field_source
           where entity = ${object.key} and entity_id = ${input.entityId}`,
    )
    const sourceOf = new Map(sources.map((row) => [row.field_key, row.source]))

    const result: EnrichmentResult = { written: [], suggested: [], unchanged: [], unknown: [] }
    const custom = (current.custom ?? {}) as Record<string, unknown>

    for (const [key, raw] of Object.entries(input.values)) {
      const field = object.byKey.get(key)
      if (!field || field.isSystem) {
        result.unknown.push(key)
        continue
      }

      const { value } = coerce(fieldOrThrow(object, key), raw)
      if (value === null || value === undefined || value === '') {
        // A provider returning nothing for a field is not a reason to blank it.
        result.unchanged.push(key)
        continue
      }

      const existing = field.storage === 'column' ? current[field.columnName!] : custom[field.key]
      const filled = existing !== null && existing !== undefined && existing !== ''

      if (filled && String(existing) === String(value)) {
        result.unchanged.push(key)
        continue
      }

      // The whole rule, in one condition. Anything with no recorded provenance is
      // treated as human: the safe reading of "we do not know where this came
      // from" is "somebody typed it".
      const provenance = sourceOf.get(key) ?? (filled ? 'human' : null)
      if (filled && provenance !== 'enrichment') {
        await tx
          .insert(enrichmentSuggestion)
          .values({
            accountId: ctx.accountId,
            entity: object.key,
            entityId: input.entityId,
            fieldKey: key,
            suggested: String(value),
            current: String(existing),
            provider: input.provider,
          })
          .onConflictDoUpdate({
            target: [
              enrichmentSuggestion.accountId,
              enrichmentSuggestion.entity,
              enrichmentSuggestion.entityId,
              enrichmentSuggestion.fieldKey,
            ],
            set: { suggested: String(value), current: String(existing), provider: input.provider, at: new Date() },
          })
        result.suggested.push(key)
        continue
      }

      if (field.storage === 'column') {
        await tx.execute(sql`
          update ${table}
             set ${sql.raw(`"${field.columnName}"`)} = ${value as never}, updated_at = now()
           where id = ${input.entityId}`)
      } else {
        await tx.execute(sql`
          update ${table}
             set custom = coalesce(custom, '{}'::jsonb) || ${JSON.stringify({ [key]: value })}::jsonb,
                 updated_at = now()
           where id = ${input.entityId}`)
      }
      await recordFieldSource(tx, ctx, {
        entity: object.key,
        entityId: input.entityId,
        fieldKey: key,
        source: 'enrichment',
        provider: input.provider,
      })
      result.written.push(key)
    }

    if (result.written.length > 0 || result.suggested.length > 0) {
      await writeAudit(tx, ctx, {
        entity: object.key,
        entityId: input.entityId,
        action: 'enrich',
        before: { provider: input.provider },
        after: { written: result.written, suggested: result.suggested },
      })
      await recordActivity(tx, ctx, {
        type: 'enrichment',
        subject:
          result.written.length > 0
            ? `${input.provider} filled ${result.written.length} field${result.written.length === 1 ? '' : 's'}`
            : `${input.provider} suggested ${result.suggested.length} change${result.suggested.length === 1 ? '' : 's'}`,
        payload: { provider: input.provider, ...result },
        links: [{ entityType: assertCore(object, 'be enriched'), entityId: input.entityId }],
      })
    }

    return result
  })
}

/** Accepting a suggestion is a human decision, so the value is written with human
 *  provenance and enrichment can never take it back. */
export const acceptSuggestion = async (
  ctx: AccountContext,
  suggestionId: string,
): Promise<{ fieldKey: string }> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(enrichmentSuggestion)
      .where(sql`${enrichmentSuggestion.id} = ${suggestionId}`)
      .limit(1)
    if (!row) throw new Error('That suggestion is no longer there.')

    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, row.entity)
    assertCanWrite(ctx, object.key)
    const field = fieldOrThrow(object, row.fieldKey)
    const { value } = coerce(field, row.suggested)
    const table = sql.raw(`"${object.key}"`)

    if (field.storage === 'column') {
      await tx.execute(sql`
        update ${table} set ${sql.raw(`"${field.columnName}"`)} = ${value as never}, updated_at = now()
         where id = ${row.entityId}`)
    } else {
      await tx.execute(sql`
        update ${table}
           set custom = coalesce(custom, '{}'::jsonb) || ${JSON.stringify({ [row.fieldKey]: value })}::jsonb,
               updated_at = now()
         where id = ${row.entityId}`)
    }

    await recordFieldSource(tx, ctx, {
      entity: object.key,
      entityId: row.entityId,
      fieldKey: row.fieldKey,
      source: 'human',
      provider: null,
    })
    await tx.delete(enrichmentSuggestion).where(sql`${enrichmentSuggestion.id} = ${suggestionId}`)
    await writeAudit(tx, ctx, {
      entity: object.key,
      entityId: row.entityId,
      action: 'accept_suggestion',
      before: { value: row.current },
      after: { value: row.suggested, provider: row.provider },
    })

    return { fieldKey: row.fieldKey }
  })

/** Marks the fields a form, an import or a booking wrote, so enrichment knows to
 *  leave them alone. Called from the capture paths rather than inferred later. */
export const markSource = async (
  tx: Tx,
  ctx: AccountContext,
  input: { entity: string; entityId: string; fieldKeys: string[]; source: 'form' | 'import' | 'booking' | 'human' },
): Promise<void> => {
  for (const fieldKey of input.fieldKeys) {
    await recordFieldSource(tx, ctx, {
      entity: input.entity,
      entityId: input.entityId,
      fieldKey,
      source: input.source,
    })
  }
}

/** Asks for a record to be enriched, once somebody approves the batch.
 *
 *  Called on every path that gives a contact an email or a company a domain,
 *  because that key is the only thing an enricher can match on. Writing the row
 *  spends nothing: it is a question, and `approveEnrichment` is the answer.
 *  Idempotent, and a row already approved is left approved. */
export const requestEnrichment = async (
  tx: Tx,
  ctx: AccountContext,
  entity: 'contact' | 'company',
  entityId: string,
): Promise<void> => {
  // Written as a statement rather than through the query builder. The builder
  // sends this on the same connection a mail ingest is using for a megabyte of
  // message body, and the two together corrupted that parameter: Postgres
  // refused a NUL byte in text the caller never wrote. See verify:mail's
  // oversized-body check, which is what caught it.
  await tx.execute(sql`
    insert into enrichment_request (account_id, entity, entity_id)
    values (${ctx.accountId}, ${entity}, ${entityId})
    on conflict do nothing`)
}

/** Taken off the queue, whichever way it was enriched: the worker claims a row
 *  as it runs, and the button on a record is consent for that one record. */
export const clearEnrichmentRequest = async (
  ctx: AccountContext,
  entity: 'contact' | 'company',
  entityId: string,
): Promise<void> => {
  await withAccount(ctx, async (tx) => {
    await tx.execute(
      sql`delete from enrichment_request where entity = ${entity} and entity_id = ${entityId}`,
    )
  })
}

export type PendingEnrichment = {
  contacts: number
  companies: number
  total: number
  /** The oldest thing waiting, so the prompt can say how long it has been. */
  since: Date | null
}

/** What is waiting for a person to say yes. Counted rather than listed: the
 *  decision is "these many records, this many credits", and a list of ninety
 *  thousand names is not a decision anybody can read. */
export const pendingEnrichment = async (ctx: AccountContext): Promise<PendingEnrichment> =>
  withAccount(ctx, async (tx) => {
    // Only records that are still here. A row whose record was deleted or merged
    // away is cleared at the source, but erasure and a hand-run delete do not go
    // through that path, and a count that over-reports is the one number this
    // prompt must never get wrong.
    const rows = await tx.execute<{ entity: string; n: number; oldest: Date }>(
      sql`select r.entity, count(*)::int as n, min(r.requested_at) as oldest
            from enrichment_request r
           where r.approved_at is null
             and case r.entity
                   when 'contact' then exists (select 1 from contact c where c.id = r.entity_id and c.deleted_at is null)
                   when 'company' then exists (select 1 from company c where c.id = r.entity_id and c.deleted_at is null)
                   else false
                 end
           group by r.entity`,
    )
    const of = (entity: string) => rows.find((row) => row.entity === entity)?.n ?? 0
    const oldest = rows
      .map((row) => new Date(row.oldest))
      .sort((a, b) => a.getTime() - b.getTime())[0]
    return { contacts: of('contact'), companies: of('company'), total: of('contact') + of('company'), since: oldest ?? null }
  })

/** Yes. Every record waiting at this moment is released to the worker.
 *
 *  Anything queued after this click waits for its own approval, which is the
 *  point: consent is given for a batch somebody was shown the size of, never
 *  standing consent for whatever arrives next. */
export const approveEnrichment = async (ctx: AccountContext): Promise<{ approved: number }> => {
  assertCanWrite(ctx, 'contact')
  return withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{ n: number }>(
      sql`update enrichment_request set approved_at = now() where approved_at is null returning 1 as n`,
    )
    await writeAudit(tx, ctx, {
      entity: 'enrichment_request',
      entityId: null,
      action: 'approve',
      before: null,
      after: { approved: rows.length },
    })
    return { approved: rows.length }
  })
}

/** No. The requests are dropped, and nothing is enriched.
 *
 *  The records themselves are untouched; a later edit to an email or a domain
 *  asks again, and the button on a record still enriches that one. */
export const discardEnrichment = async (ctx: AccountContext): Promise<{ discarded: number }> => {
  assertCanWrite(ctx, 'contact')
  return withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{ n: number }>(
      sql`delete from enrichment_request where approved_at is null returning 1 as n`,
    )
    await writeAudit(tx, ctx, {
      entity: 'enrichment_request',
      entityId: null,
      action: 'discard',
      before: { waiting: rows.length },
      after: null,
    })
    return { discarded: rows.length }
  })
}

/** Whether a record is on the queue, and whether it has been let through. The
 *  panel says "waiting for you" rather than "queued" while it is still a
 *  question. */
export const enrichmentQueued = async (
  ctx: AccountContext,
  entity: 'contact' | 'company',
  entityId: string,
): Promise<'waiting' | 'approved' | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{ approved_at: Date | null }>(
      sql`select approved_at from enrichment_request
           where entity = ${entity} and entity_id = ${entityId} limit 1`,
    )
    if (!row) return null
    return row.approved_at ? 'approved' : 'waiting'
  })
