import { sql } from 'drizzle-orm'
import { enrichmentSuggestion } from '../schema/platform.ts'
import type { ObjectKey } from '../registry/core.ts'
import { recordActivity } from './activity.ts'
import type { WorkspaceContext } from './context.ts'
import { assertCanWrite } from './context.ts'
import { withWorkspace, writeAudit, type Tx } from './index.ts'
import { recordFieldSource } from './integrations.ts'
import { fieldOrThrow, getRegistryIn, objectOrThrow } from './registry.ts'
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
  ctx: WorkspaceContext,
  input: EnrichmentInput,
): Promise<EnrichmentResult> => {
  assertCanWrite(ctx, input.objectKey)

  return withWorkspace(ctx, async (tx) => {
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
            workspaceId: ctx.workspaceId,
            entity: object.key,
            entityId: input.entityId,
            fieldKey: key,
            suggested: String(value),
            current: String(existing),
            provider: input.provider,
          })
          .onConflictDoUpdate({
            target: [
              enrichmentSuggestion.workspaceId,
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
        links: [{ entityType: object.key, entityId: input.entityId }],
      })
    }

    return result
  })
}

/** Accepting a suggestion is a human decision, so the value is written with human
 *  provenance and enrichment can never take it back. */
export const acceptSuggestion = async (
  ctx: WorkspaceContext,
  suggestionId: string,
): Promise<{ fieldKey: string }> =>
  withWorkspace(ctx, async (tx) => {
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
  ctx: WorkspaceContext,
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
