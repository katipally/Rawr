import { and, eq, isNull } from 'drizzle-orm'
import { IMMUTABLE_PARSER, TYPE_META, type FieldType } from '../registry/types.ts'
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Postgres folds a longer identifier, so the name on record would not be the one built. */
const MAX_INDEX_NAME = 63
const HOT_INDEX_NAME = /^hot_[a-z0-9_]+$/

/** The cast query.ts `fieldExpression` puts over `custom ->> key`, for the types an
 *  index on that same expression can exist for. A text value needs none (a `::text`
 *  over text is dropped by the parser). A date or a moment is read through
 *  `IMMUTABLE_PARSER` instead of a cast, which Postgres refuses in an index
 *  expression. `jsonb` is left out on purpose: its filters are list membership
 *  (`?|`) and key presence, which a btree on the value never serves. */
const INDEX_CAST: Partial<Record<(typeof TYPE_META)[FieldType]['jsonbCast'], string>> = {
  text: '',
  numeric: '::numeric',
  boolean: '::boolean',
}

/** Core objects keep their existing index whatever the type; only a custom object's
 *  index is built to match its field's expression, so only there can a type be refused. */
export const unindexableReason = (type: FieldType, isCustomObject: boolean): string | null => {
  const cast = TYPE_META[type].jsonbCast
  return !isCustomObject || cast in INDEX_CAST || cast in IMMUTABLE_PARSER
    ? null
    : `A ${type.replaceAll('_', ' ')} property cannot be indexed on a custom object: its filters look inside a list or a document, which an ordinary index cannot serve.`
}

export type IndexTarget = {
  fieldId: string
  fieldKey: string
  fieldType: FieldType
  objectKey: string
  objectId: string
  isCustomObject: boolean
}

/** Every identifier and literal in the statement comes from a key that passed
 *  `assertUsableFieldKey` or from a uuid that matched UUID, so the charset is
 *  [a-z0-9_-] and cannot close a quote. CONCURRENTLY forbids a transaction, so a
 *  prepared statement or a DO block is not an option.
 *
 *  A core object's index is on its own table. A custom object's rows share
 *  `custom_record` with every account, so its index is partial on the one object
 *  (and so on the one account), and named by the field's id so two accounts that
 *  index the same key never meet. The predicate is a constant because an index
 *  predicate cannot be a parameter; the query's `object_id = $1` is a bound value
 *  the planner proves it against when it plans with the value known. */
export const planFieldIndex = (target: IndexTarget): { name: string; create: string } => {
  assertUsableFieldKey(target.fieldKey)
  const blocked = unindexableReason(target.fieldType, target.isCustomObject)
  if (blocked) throw new Error(blocked)

  if (!target.isCustomObject) {
    assertUsableFieldKey(target.objectKey)
    const name = `hot_${target.objectKey}_${target.fieldKey}`
    if (name.length > MAX_INDEX_NAME) {
      throw new Error(`"${target.fieldKey}" is too long for its index name; shorten the key to index it.`)
    }
    return {
      name,
      create:
        `create index concurrently if not exists "${name}" on "${target.objectKey}" ` +
        `(((custom->>'${target.fieldKey}'))) where custom ? '${target.fieldKey}'`,
    }
  }

  if (!UUID.test(target.fieldId) || !UUID.test(target.objectId)) {
    throw new Error('The field or its object has no valid id, so its index cannot be named.')
  }
  const name = `hot_cr_${target.fieldId.replaceAll('-', '')}`
  const cast = TYPE_META[target.fieldType].jsonbCast
  const parser = IMMUTABLE_PARSER[cast]
  const value = `(custom ->> '${target.fieldKey}')`
  return {
    name,
    create:
      `create index concurrently if not exists "${name}" on custom_record ` +
      `((${parser ? `${parser}${value}` : `${value}${INDEX_CAST[cast]}`})) where object_id = '${target.objectId}'`,
  }
}

export const dropIndexSql = (name: string): string => {
  if (!HOT_INDEX_NAME.test(name) || name.length > MAX_INDEX_NAME) {
    throw new Error(`"${name}" is not an index this system builds, so it will not be dropped.`)
  }
  return `drop index concurrently if exists "${name}"`
}

/** A statement Postgres rejects as written (SQLSTATE class 42: missing relation,
 *  bad expression) fails the same way every time; a retry only repeats it. A date
 *  index built before migration 0102 ran is one: its row ends as 'failed' and is
 *  asked again with "Retry index" once the migration has. */
export const isPermanentSqlError = (cause: unknown): boolean => {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.startsWith('42')
}

export type PromotedField = {
  fieldIndexId: string
  pgIndexName: string
  objectKey: string
  fieldKey: string
}

/** Marks a custom field hot and records the index that has to exist for it. The
 *  index itself is built by a job, because CREATE INDEX CONCURRENTLY cannot run
 *  inside a request or inside a transaction. A field whose build failed is asked
 *  again through the same call. */
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
        objectId: objectDef.id,
        isCustomObject: objectDef.isCustom,
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

    const { name: pgIndexName } = planFieldIndex({
      fieldId,
      fieldKey: found.key,
      fieldType: found.type as FieldType,
      objectKey: found.objectKey,
      objectId: found.objectId,
      isCustomObject: found.isCustomObject,
    })

    if (found.isHot) {
      const [failed] = await tx
        .update(fieldIndex)
        .set({ state: 'pending', lastError: null, attempts: 0, claimedAt: null })
        .where(and(eq(fieldIndex.fieldId, fieldId), eq(fieldIndex.state, 'failed')))
        .returning({ id: fieldIndex.id })
      if (!failed) throw new Error(`${found.key} is already a hot field.`)
      return {
        result: { fieldIndexId: failed.id, pgIndexName, objectKey: found.objectKey, fieldKey: found.key },
        audit: {
          entity: 'field_def',
          entityId: fieldId,
          action: 'retry_index',
          before: { indexState: 'failed' },
          after: { indexState: 'pending', pgIndexName },
        },
      }
    }

    await tx.update(fieldDef).set({ isHot: true }).where(eq(fieldDef.id, fieldId))

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
