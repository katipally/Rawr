import { and, eq, isNull } from 'drizzle-orm'
import { fieldDef, fieldIndex, objectDef } from '../schema/metadata.ts'
import { mutate } from './index.ts'
import type { AccountContext } from './context.ts'

/** Validated once, here, and never anywhere else. Everything that reaches DDL comes
 *  from a key that passed this. */
export const FIELD_KEY = /^[a-z][a-z0-9_]{0,58}$/

export const RESERVED_KEYS = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'authorization', 'between',
  'binary', 'both', 'case', 'cast', 'check', 'collate', 'column', 'constraint', 'create', 'cross',
  'current_date', 'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable',
  'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'for', 'foreign', 'freeze', 'from',
  'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially', 'inner', 'intersect', 'into',
  'is', 'isnull', 'join', 'leading', 'left', 'like', 'limit', 'localtime', 'localtimestamp',
  'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order', 'outer', 'overlaps',
  'placing', 'primary', 'references', 'right', 'select', 'session_user', 'similar', 'some',
  'table', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'user', 'using', 'verbose',
  'when', 'where',
])

export const assertUsableFieldKey = (key: string): void => {
  if (!FIELD_KEY.test(key)) {
    throw new Error(
      `"${key}" is not a usable field key. Use lowercase letters, digits and underscores, starting with a letter, up to 59 characters.`,
    )
  }
  if (RESERVED_KEYS.has(key)) {
    throw new Error(`"${key}" is a Postgres reserved word, so it cannot be a field key.`)
  }
}

export type PromotedField = {
  fieldIndexId: string
  pgIndexName: string
  objectKey: string
  fieldKey: string
}

/** Marks a custom field hot and records the index that has to exist for it. The
 *  index itself is built by a job, because CREATE INDEX CONCURRENTLY cannot run
 *  inside a request or inside a transaction. */
export const promoteFieldToHot = async (
  ctx: AccountContext,
  fieldId: string,
): Promise<PromotedField> =>
  mutate(ctx, 'field_def', async (tx) => {
    const [found] = await tx
      .select({
        id: fieldDef.id,
        key: fieldDef.key,
        storage: fieldDef.storage,
        isHot: fieldDef.isHot,
        type: fieldDef.type,
        objectKey: objectDef.key,
      })
      .from(fieldDef)
      .innerJoin(objectDef, eq(objectDef.id, fieldDef.objectId))
      .where(and(eq(fieldDef.id, fieldId), isNull(fieldDef.deletedAt)))
      .limit(1)

    if (!found) {
      throw new Error('That field does not exist in this account, or it has been deleted.')
    }
    if (found.storage !== 'jsonb') {
      throw new Error(
        `${found.key} is stored in its own column, which is already indexed. Only custom fields are promoted.`,
      )
    }
    if (found.isHot) {
      throw new Error(`${found.key} is already a hot field.`)
    }
    assertUsableFieldKey(found.key)
    assertUsableFieldKey(found.objectKey)

    await tx.update(fieldDef).set({ isHot: true }).where(eq(fieldDef.id, fieldId))

    const pgIndexName = `hot_${found.objectKey}_${found.key}`
    const [created] = await tx
      .insert(fieldIndex)
      .values({
        accountId: ctx.accountId,
        fieldId,
        pgIndexName,
        state: 'pending',
      })
      .returning({ id: fieldIndex.id })

    if (!created) throw new Error('The index record could not be written.')

    return {
      result: {
        fieldIndexId: created.id,
        pgIndexName,
        objectKey: found.objectKey,
        fieldKey: found.key,
      },
      audit: {
        entity: 'field_def',
        entityId: fieldId,
        action: 'promote_to_hot',
        before: { isHot: false },
        after: { isHot: true, pgIndexName },
      },
    }
  })
