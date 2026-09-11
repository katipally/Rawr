import { eq, sql } from 'drizzle-orm'
import { bulkOperation } from '../schema/bulk.ts'
import type { EntityRef } from './activity.ts'
import { associateMany } from './associations.ts'
import { assertCanDo, type AccountContext } from './context.ts'
import { isUuid, withAccount, type Tx } from './index.ts'
import { assertIdsBelong, bulkDeleteRecords, bulkUpdateRecords, mergeRecords } from './records.ts'
import { getRegistryIn, objectOrThrow } from './registry.ts'
import { addToList } from './segments.ts'

/** What the bulk bar does to a selection.
 *
 *  Two paths, one decision. Under the threshold the work happens in the request
 *  and the person sees the result: that is what a bulk edit has always been, and
 *  a hundred records is well inside what a round trip can carry. Over it the same
 *  work is written down as a `bulk_operation` and the worker asks the app for one
 *  chunk at a time, exactly the way an import runs, because a person deleting
 *  eighty thousand records will close the tab long before the request answers.
 *
 *  The threshold is not a guess about speed. It is the point past which somebody
 *  would reasonably walk away, and a run that cannot survive them walking away is
 *  a run that loses their work. */

/** Above this a selection becomes a job. Chosen so the inline path stays inside
 *  one comfortable request and the chunked path starts before anybody waits. */
export const BULK_INLINE_MAX = 200

/** One chunk, matching the importer's. Small enough that a stopped run stops
 *  promptly and a failure costs one chunk of work. */
const CHUNK = 200

/** A selection this large is not a selection, it is a filter somebody should have
 *  narrowed. Refused rather than queued, because the ids are stored as one array
 *  and the honest ceiling is the one that keeps that true. */
const MAX_IDS = 50_000

/** Only a sample is kept: five hundred identical refusals help nobody, and the
 *  count is what says how bad it was. */
const MAX_ERRORS = 20

export type BulkFailure = { id: string; displayName: string; reason: string }

export type BulkAction =
  | { type: 'delete' }
  | { type: 'assign'; ownerId: string | null }
  | { type: 'associate'; target: EntityRef; label?: string | null }
  | { type: 'add_to_list'; listId: string }
  | { type: 'merge'; survivorId: string }

export type BulkProgress = {
  id: string
  kind: string
  objectKey: string
  state: 'running' | 'done' | 'failed'
  total: number
  processed: number
  failedCount: number
  errors: BulkFailure[]
  lastError: string | null
}

export type BulkStart =
  | { mode: 'inline'; processed: number; failed: BulkFailure[] }
  | { mode: 'queued'; operationId: string; total: number }

const toState = (value: string): BulkProgress['state'] =>
  value === 'done' || value === 'failed' ? value : 'running'

/** Applies one action to one batch. Every branch delegates to the DAL a person's
 *  own edit goes through, so a bulk delete is the same soft delete, the same
 *  audit row and the same timeline entry as deleting one by hand. */
const applyBatch = async (
  ctx: AccountContext,
  objectKey: string,
  action: BulkAction,
  ids: string[],
): Promise<{ processed: number; failed: BulkFailure[] }> => {
  switch (action.type) {
    case 'delete': {
      const result = await bulkDeleteRecords(ctx, objectKey, ids)
      return { processed: result.deleted, failed: result.failed }
    }
    case 'assign': {
      const result = await bulkUpdateRecords(ctx, objectKey, ids, { owner_id: action.ownerId })
      return { processed: result.updated, failed: result.failed }
    }
    case 'associate': {
      await associateMany(ctx, objectKey, ids, action.target, action.label ?? null)
      return { processed: ids.length, failed: [] }
    }
    case 'add_to_list': {
      await addToList(ctx, action.listId, ids)
      // Somebody already on the list is not a failure, so the batch counts as
      // done either way: the list holds what it was asked to hold.
      return { processed: ids.length, failed: [] }
    }
    case 'merge': {
      const [absorbedId] = ids.filter((id) => id !== action.survivorId)
      if (!absorbedId) throw new Error('A merge needs two different records.')
      await mergeRecords(ctx, {
        objectKey,
        survivorId: action.survivorId,
        absorbedId,
        picks: {},
      })
      return { processed: 2, failed: [] }
    }
  }
}

/** Runs the selection, or writes it down for the worker to run. */
export const startBulkOperation = async (
  ctx: AccountContext,
  input: { objectKey: string; ids: string[]; action: BulkAction },
): Promise<BulkStart> => {
  // Asked here as well as in the delete and merge layers, because a selection
  // above the inline limit is written down for the worker and never passes
  // through either of them.
  if (input.action.type === 'delete') assertCanDo(ctx, 'bulk_delete')
  if (input.action.type === 'merge') assertCanDo(ctx, 'merge')

  const ids = [...new Set(input.ids)]
  if (ids.length === 0) throw new Error('Nothing was selected.')
  if (ids.some((id) => !isUuid(id))) throw new Error('That selection holds something that is not a record.')
  if (ids.length > MAX_IDS) {
    throw new Error(
      `That is ${ids.length.toLocaleString()} records in one action; ${MAX_IDS.toLocaleString()} is the limit. Narrow the view and run it twice.`,
    )
  }
  if (input.action.type === 'merge') {
    if (ids.length !== 2) throw new Error('Merging takes exactly two records: the one to keep and the one to absorb.')
    if (!ids.includes(input.action.survivorId)) {
      throw new Error('The record being kept is not one of the two selected.')
    }
  }

  // Before anything is written, and once for the whole selection: an id from
  // another account stops the action rather than quietly reducing it.
  await withAccount(ctx, async (tx) => {
    const object = objectOrThrow(await getRegistryIn(tx), input.objectKey)
    await assertIdsBelong(tx, object, ids)
  })

  if (ids.length <= BULK_INLINE_MAX || input.action.type === 'merge') {
    const result = await applyBatch(ctx, input.objectKey, input.action, ids)
    return { mode: 'inline', processed: result.processed, failed: result.failed }
  }

  const [created] = await withAccount(ctx, (tx) =>
    tx
      .insert(bulkOperation)
      .values({
        accountId: ctx.accountId,
        kind: input.action.type,
        objectKey: input.objectKey,
        ids,
        config: input.action,
        total: ids.length,
        createdBy: ctx.actorId,
      })
      .returning({ id: bulkOperation.id }),
  )
  if (!created) throw new Error('The action could not be started.')
  return { mode: 'queued', operationId: created.id, total: ids.length }
}

const rowOf = async (tx: Tx, id: string) => {
  const [row] = await tx
    .select({
      id: bulkOperation.id,
      kind: bulkOperation.kind,
      objectKey: bulkOperation.objectKey,
      state: bulkOperation.state,
      total: bulkOperation.total,
      processed: bulkOperation.processed,
      failedCount: bulkOperation.failedCount,
      errors: bulkOperation.errors,
      lastError: bulkOperation.lastError,
      config: bulkOperation.config,
    })
    .from(bulkOperation)
    .where(eq(bulkOperation.id, id))
    .limit(1)
  return row
}

export const readBulkOperation = async (
  ctx: AccountContext,
  id: string,
): Promise<BulkProgress | null> =>
  withAccount(ctx, async (tx) => {
    const row = await rowOf(tx, id)
    if (!row) return null
    return {
      id: row.id,
      kind: row.kind,
      objectKey: row.objectKey,
      state: toState(row.state),
      total: row.total,
      processed: row.processed,
      failedCount: row.failedCount,
      errors: (row.errors as BulkFailure[]) ?? [],
      lastError: row.lastError,
    }
  })

/** One chunk of a queued action, called repeatedly by the worker.
 *
 *  `processed` is the resume cursor as well as the progress, so a run interrupted
 *  by a deploy picks up at the id after the last one it wrote instead of starting
 *  again. The slice is taken in Postgres rather than read back into memory: the
 *  array is one column and only the part being worked on needs to cross. */
export const runBulkChunk = async (
  ctx: AccountContext,
  id: string,
): Promise<{ done: boolean; processed: number; total: number }> => {
  const row = await withAccount(ctx, (tx) => rowOf(tx, id))
  if (!row) throw new Error('That action no longer exists.')
  if (row.state !== 'running') {
    return { done: true, processed: row.processed, total: row.total }
  }

  const [slice] = await withAccount(ctx, (tx) =>
    tx.execute<{ ids: string[] }>(sql`
      select ids[${row.processed + 1}:${row.processed + CHUNK}] as ids
        from bulk_operation where id = ${id}`),
  )
  const batch = slice?.ids ?? []
  if (batch.length === 0) {
    await withAccount(ctx, (tx) =>
      tx
        .update(bulkOperation)
        .set({ state: 'done', finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(bulkOperation.id, id)),
    )
    return { done: true, processed: row.processed, total: row.total }
  }

  try {
    const result = await applyBatch(ctx, row.objectKey, row.config as BulkAction, batch)
    const errors = [...((row.errors as BulkFailure[]) ?? []), ...result.failed].slice(0, MAX_ERRORS)
    // The cursor advances by the whole batch, not by what succeeded: a row that
    // refused the change is recorded and walked past, or the run would offer it
    // the same refusal for ever.
    const processed = row.processed + batch.length
    const done = processed >= row.total
    await withAccount(ctx, (tx) =>
      tx
        .update(bulkOperation)
        .set({
          processed,
          failedCount: row.failedCount + result.failed.length,
          errors,
          state: done ? 'done' : 'running',
          finishedAt: done ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(bulkOperation.id, id)),
    )
    return { done, processed, total: row.total }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await withAccount(ctx, (tx) =>
      tx
        .update(bulkOperation)
        .set({ state: 'failed', lastError: message, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(bulkOperation.id, id)),
    )
    throw cause
  }
}
