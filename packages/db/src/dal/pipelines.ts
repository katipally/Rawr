import { and, asc, eq, sql } from 'drizzle-orm'
import { deal, lifecycleStage, pipeline, pipelineStage } from '../schema/records.ts'
import { recordActivity } from './activity.ts'
import type { WorkspaceContext } from './context.ts'
import { mutate, withWorkspace, type Tx } from './index.ts'

/** Pipelines, their stages, and the lifecycle stage list. All three are workspace
 *  configuration that F1 assumed would be editable and that nothing could edit.
 *
 *  The rule that shapes this file is the one from F1's edge-case table: a stage
 *  with deals in it cannot simply disappear. Deleting one requires naming where its
 *  deals go, and every deal that moves writes its own stage_change, so the timeline
 *  reads as a move rather than a gap. */

export type StageRow = {
  id: string
  name: string
  probability: number | null
  position: number
  isClosedWon: boolean
  isClosedLost: boolean
  dealCount: number
}

export type PipelineRow = {
  id: string
  name: string
  position: number
  stages: StageRow[]
  dealCount: number
}

export const listPipelines = async (ctx: WorkspaceContext): Promise<PipelineRow[]> =>
  withWorkspace(ctx, async (tx) => {
    const [pipelines, stages, counts] = await Promise.all([
      tx
        .select({ id: pipeline.id, name: pipeline.name, position: pipeline.position })
        .from(pipeline)
        .orderBy(asc(pipeline.position), asc(pipeline.name)),
      tx
        .select({
          id: pipelineStage.id,
          pipelineId: pipelineStage.pipelineId,
          name: pipelineStage.name,
          probability: pipelineStage.probability,
          position: pipelineStage.position,
          isClosedWon: pipelineStage.isClosedWon,
          isClosedLost: pipelineStage.isClosedLost,
        })
        .from(pipelineStage)
        .orderBy(asc(pipelineStage.position)),
      tx.execute<{ stage_id: string; n: number }>(
        sql`select stage_id, count(*)::int as n from deal where deleted_at is null group by stage_id`,
      ),
    ])

    const perStage = new Map(counts.map((row) => [row.stage_id, Number(row.n)]))
    return pipelines.map((row) => {
      const own = stages
        .filter((stage) => stage.pipelineId === row.id)
        .map((stage) => ({
          id: stage.id,
          name: stage.name,
          probability: stage.probability === null ? null : Number(stage.probability),
          position: stage.position,
          isClosedWon: stage.isClosedWon,
          isClosedLost: stage.isClosedLost,
          dealCount: perStage.get(stage.id) ?? 0,
        }))
      return {
        id: row.id,
        name: row.name,
        position: row.position,
        stages: own,
        dealCount: own.reduce((sum, stage) => sum + stage.dealCount, 0),
      }
    })
  })

const nextPosition = async (tx: Tx, table: 'pipeline' | 'pipeline_stage' | 'lifecycle_stage', where: string): Promise<number> => {
  const [row] = await tx.execute<{ next: number }>(
    sql`select coalesce(max(position), -1) + 1 as next from ${sql.raw(table)} where ${sql.raw(where)}`,
  )
  return Number(row?.next ?? 0)
}

export const createPipeline = async (ctx: WorkspaceContext, name: string): Promise<{ id: string }> =>
  mutate(ctx, 'pipeline', async (tx) => {
    const clean = name.trim()
    if (!clean) throw new Error('A pipeline needs a name.')

    const [created] = await tx
      .insert(pipeline)
      .values({
        workspaceId: ctx.workspaceId,
        name: clean,
        position: await nextPosition(tx, 'pipeline', 'true'),
      })
      .returning({ id: pipeline.id })
    if (!created) throw new Error('The pipeline could not be created.')

    return {
      result: { id: created.id },
      audit: { entity: 'pipeline', entityId: created.id, action: 'create', before: null, after: { name: clean } },
    }
  })

export const renamePipeline = async (ctx: WorkspaceContext, id: string, name: string): Promise<void> =>
  mutate(ctx, 'pipeline', async (tx) => {
    const clean = name.trim()
    if (!clean) throw new Error('A pipeline needs a name.')
    const [before] = await tx.select({ name: pipeline.name }).from(pipeline).where(eq(pipeline.id, id)).limit(1)
    if (!before) throw new Error('That pipeline no longer exists.')

    await tx.update(pipeline).set({ name: clean }).where(eq(pipeline.id, id))
    return {
      result: undefined,
      audit: { entity: 'pipeline', entityId: id, action: 'rename', before, after: { name: clean } },
    }
  })

/** A pipeline with deals in it is not deletable at all: there is no "move these
 *  somewhere else" that makes sense across pipelines, because the stages differ.
 *  Emptying it first is the honest path and the message says so. */
export const deletePipeline = async (ctx: WorkspaceContext, id: string): Promise<void> =>
  mutate(ctx, 'pipeline', async (tx) => {
    const [found] = await tx.select({ name: pipeline.name }).from(pipeline).where(eq(pipeline.id, id)).limit(1)
    if (!found) throw new Error('That pipeline no longer exists.')

    const [{ n = 0 } = { n: 0 }] = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from deal where pipeline_id = ${id} and deleted_at is null`,
    )
    if (Number(n) > 0) {
      throw new Error(
        `${found.name} still holds ${n} deal${Number(n) === 1 ? '' : 's'}. Move them to another pipeline first; deleting would leave them with no stage.`,
      )
    }

    const [{ total = 0 } = { total: 0 }] = await tx.execute<{ total: number }>(
      sql`select count(*)::int as total from pipeline`,
    )
    if (Number(total) <= 1) throw new Error('A workspace needs at least one pipeline.')

    await tx.delete(pipelineStage).where(eq(pipelineStage.pipelineId, id))
    await tx.delete(pipeline).where(eq(pipeline.id, id))

    return {
      result: undefined,
      audit: { entity: 'pipeline', entityId: id, action: 'delete', before: found, after: null },
    }
  })

export type StageInput = {
  pipelineId: string
  name: string
  probability?: number | null
  isClosedWon?: boolean
  isClosedLost?: boolean
}

const validProbability = (value: number | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error('A probability is a whole percentage between 0 and 100.')
  }
  return String(Math.round(value))
}

export const createStage = async (ctx: WorkspaceContext, input: StageInput): Promise<{ id: string }> =>
  mutate(ctx, 'pipeline_stage', async (tx) => {
    const clean = input.name.trim()
    if (!clean) throw new Error('A stage needs a name.')
    if (input.isClosedWon && input.isClosedLost) {
      throw new Error('A stage is either closed won or closed lost, never both.')
    }
    const [owner] = await tx.select({ id: pipeline.id }).from(pipeline).where(eq(pipeline.id, input.pipelineId)).limit(1)
    if (!owner) throw new Error('That pipeline no longer exists.')

    const [created] = await tx
      .insert(pipelineStage)
      .values({
        workspaceId: ctx.workspaceId,
        pipelineId: input.pipelineId,
        name: clean,
        probability: validProbability(input.probability),
        isClosedWon: input.isClosedWon ?? false,
        isClosedLost: input.isClosedLost ?? false,
        position: await nextPosition(tx, 'pipeline_stage', `pipeline_id = '${input.pipelineId}'`),
      })
      .returning({ id: pipelineStage.id })
    if (!created) throw new Error('The stage could not be created.')

    return {
      result: { id: created.id },
      audit: { entity: 'pipeline_stage', entityId: created.id, action: 'create', before: null, after: { name: clean } },
    }
  })

export const updateStage = async (
  ctx: WorkspaceContext,
  input: { id: string; name?: string; probability?: number | null; isClosedWon?: boolean; isClosedLost?: boolean },
): Promise<void> =>
  mutate(ctx, 'pipeline_stage', async (tx) => {
    const [before] = await tx
      .select({
        name: pipelineStage.name,
        probability: pipelineStage.probability,
        isClosedWon: pipelineStage.isClosedWon,
        isClosedLost: pipelineStage.isClosedLost,
      })
      .from(pipelineStage)
      .where(eq(pipelineStage.id, input.id))
      .limit(1)
    if (!before) throw new Error('That stage no longer exists.')

    const won = input.isClosedWon ?? before.isClosedWon
    const lost = input.isClosedLost ?? before.isClosedLost
    if (won && lost) throw new Error('A stage is either closed won or closed lost, never both.')

    const name = input.name?.trim()
    if (input.name !== undefined && !name) throw new Error('A stage needs a name.')

    await tx
      .update(pipelineStage)
      .set({
        ...(name ? { name } : {}),
        ...(input.probability !== undefined ? { probability: validProbability(input.probability) } : {}),
        ...(input.isClosedWon !== undefined ? { isClosedWon: input.isClosedWon } : {}),
        ...(input.isClosedLost !== undefined ? { isClosedLost: input.isClosedLost } : {}),
      })
      .where(eq(pipelineStage.id, input.id))

    // No stored derived total anywhere, so a probability change is picked up by
    // the next board read. F1's edge-case table.
    return {
      result: undefined,
      audit: { entity: 'pipeline_stage', entityId: input.id, action: 'update', before, after: input },
    }
  })

export const reorderStages = async (
  ctx: WorkspaceContext,
  pipelineId: string,
  orderedIds: string[],
): Promise<void> =>
  mutate(ctx, 'pipeline_stage', async (tx) => {
    const rows = await tx
      .select({ id: pipelineStage.id })
      .from(pipelineStage)
      .where(eq(pipelineStage.pipelineId, pipelineId))
    const known = new Set(rows.map((row) => row.id))
    if (orderedIds.some((id) => !known.has(id))) {
      throw new Error('One of those stages is not on this pipeline.')
    }
    const rest = rows.map((row) => row.id).filter((id) => !orderedIds.includes(id))

    let position = 0
    for (const id of [...orderedIds, ...rest]) {
      await tx.update(pipelineStage).set({ position: position++ }).where(eq(pipelineStage.id, id))
    }

    return {
      result: undefined,
      audit: { entity: 'pipeline_stage', entityId: pipelineId, action: 'reorder', before: null, after: { order: orderedIds } },
    }
  })

export type StageDeleteResult = { moved: number }

/** F1's edge case, implemented as written: deletion requires a destination, and
 *  every deal that moves writes a stage_change so the record reads as a move rather
 *  than as history that quietly changed. */
export const deleteStage = async (
  ctx: WorkspaceContext,
  stageId: string,
  destinationStageId: string | null,
): Promise<StageDeleteResult> =>
  mutate(ctx, 'pipeline_stage', async (tx) => {
    const [found] = await tx
      .select({ id: pipelineStage.id, name: pipelineStage.name, pipelineId: pipelineStage.pipelineId })
      .from(pipelineStage)
      .where(eq(pipelineStage.id, stageId))
      .limit(1)
    if (!found) throw new Error('That stage no longer exists.')

    const deals = await tx
      .select({ id: deal.id, name: deal.name })
      .from(deal)
      .where(and(eq(deal.stageId, stageId), sql`${deal.deletedAt} is null`))

    if (deals.length > 0) {
      if (!destinationStageId) {
        throw new Error(
          `${found.name} holds ${deals.length} deal${deals.length === 1 ? '' : 's'}. Pick the stage they should move to before deleting it.`,
        )
      }
      const [destination] = await tx
        .select({ id: pipelineStage.id, name: pipelineStage.name, pipelineId: pipelineStage.pipelineId })
        .from(pipelineStage)
        .where(eq(pipelineStage.id, destinationStageId))
        .limit(1)
      if (!destination) throw new Error('That destination stage no longer exists.')
      if (destination.id === stageId) throw new Error('A stage cannot be its own destination.')
      if (destination.pipelineId !== found.pipelineId) {
        throw new Error(
          `${destination.name} is on a different pipeline. Deals move within their pipeline, so pick a stage on this one.`,
        )
      }

      await tx.update(deal).set({ stageId: destinationStageId, updatedAt: new Date() }).where(eq(deal.stageId, stageId))

      for (const moved of deals) {
        await recordActivity(tx, ctx, {
          type: 'stage_change',
          subject: `moved ${moved.name ?? 'Unnamed deal'} from ${found.name} to ${destination.name}`,
          payload: { field: 'stage_id', from: stageId, to: destinationStageId, fromLabel: found.name, toLabel: destination.name, reason: 'stage_deleted' },
          links: [{ entityType: 'deal', entityId: moved.id }],
        })
      }
    }

    await tx.delete(pipelineStage).where(eq(pipelineStage.id, stageId))

    return {
      result: { moved: deals.length },
      audit: {
        entity: 'pipeline_stage',
        entityId: stageId,
        action: 'delete',
        before: { name: found.name, deals: deals.length },
        after: { movedTo: destinationStageId },
      },
    }
  })

// ---------------------------------------------------------------- lifecycle

export type LifecycleRow = { id: string; name: string; position: number; usedBy: number }

export const listLifecycleStages = async (ctx: WorkspaceContext): Promise<LifecycleRow[]> =>
  withWorkspace(ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx
        .select({ id: lifecycleStage.id, name: lifecycleStage.name, position: lifecycleStage.position })
        .from(lifecycleStage)
        .orderBy(asc(lifecycleStage.position)),
      tx.execute<{ id: string; n: number }>(sql`
        select lifecycle_stage_id as id, count(*)::int as n from (
          select lifecycle_stage_id from contact where deleted_at is null
          union all
          select lifecycle_stage_id from company where deleted_at is null
        ) both_objects
         where lifecycle_stage_id is not null
         group by 1`),
    ])
    const used = new Map(counts.map((row) => [row.id, Number(row.n)]))
    return rows.map((row) => ({ ...row, usedBy: used.get(row.id) ?? 0 }))
  })

export const createLifecycleStage = async (ctx: WorkspaceContext, name: string): Promise<{ id: string }> =>
  mutate(ctx, 'lifecycle_stage', async (tx) => {
    const clean = name.trim()
    if (!clean) throw new Error('A lifecycle stage needs a name.')

    const [created] = await tx
      .insert(lifecycleStage)
      .values({
        workspaceId: ctx.workspaceId,
        name: clean,
        position: await nextPosition(tx, 'lifecycle_stage', 'true'),
      })
      .returning({ id: lifecycleStage.id })
    if (!created) throw new Error('The lifecycle stage could not be created.')

    return {
      result: { id: created.id },
      audit: { entity: 'lifecycle_stage', entityId: created.id, action: 'create', before: null, after: { name: clean } },
    }
  })

export const renameLifecycleStage = async (ctx: WorkspaceContext, id: string, name: string): Promise<void> =>
  mutate(ctx, 'lifecycle_stage', async (tx) => {
    const clean = name.trim()
    if (!clean) throw new Error('A lifecycle stage needs a name.')
    const [before] = await tx
      .select({ name: lifecycleStage.name })
      .from(lifecycleStage)
      .where(eq(lifecycleStage.id, id))
      .limit(1)
    if (!before) throw new Error('That lifecycle stage no longer exists.')

    await tx.update(lifecycleStage).set({ name: clean }).where(eq(lifecycleStage.id, id))
    return {
      result: undefined,
      audit: { entity: 'lifecycle_stage', entityId: id, action: 'rename', before, after: { name: clean } },
    }
  })

/** Order carries meaning here: the list is ordered because a lifecycle runs in one
 *  direction, and moving backwards is a thing worth seeing on a timeline. A2. */
export const reorderLifecycleStages = async (ctx: WorkspaceContext, orderedIds: string[]): Promise<void> =>
  mutate(ctx, 'lifecycle_stage', async (tx) => {
    const rows = await tx.select({ id: lifecycleStage.id }).from(lifecycleStage)
    const known = new Set(rows.map((row) => row.id))
    if (orderedIds.some((id) => !known.has(id))) {
      throw new Error('One of those lifecycle stages is not in this workspace.')
    }
    const rest = rows.map((row) => row.id).filter((id) => !orderedIds.includes(id))

    let position = 0
    for (const id of [...orderedIds, ...rest]) {
      await tx.update(lifecycleStage).set({ position: position++ }).where(eq(lifecycleStage.id, id))
    }

    return {
      result: undefined,
      audit: { entity: 'lifecycle_stage', entityId: ctx.workspaceId, action: 'reorder', before: null, after: { order: orderedIds } },
    }
  })

/** Records pointing at a deleted stage would render as blank, which reads as "never
 *  had one" and is a different thing. So the same rule as a pipeline stage: name
 *  where they go, or empty it first. */
export const deleteLifecycleStage = async (
  ctx: WorkspaceContext,
  id: string,
  destinationId: string | null,
): Promise<{ moved: number }> =>
  mutate(ctx, 'lifecycle_stage', async (tx) => {
    const [found] = await tx
      .select({ name: lifecycleStage.name })
      .from(lifecycleStage)
      .where(eq(lifecycleStage.id, id))
      .limit(1)
    if (!found) throw new Error('That lifecycle stage no longer exists.')

    const [{ n = 0 } = { n: 0 }] = await tx.execute<{ n: number }>(sql`
      select (
        (select count(*) from contact where lifecycle_stage_id = ${id} and deleted_at is null) +
        (select count(*) from company where lifecycle_stage_id = ${id} and deleted_at is null)
      )::int as n`)
    const used = Number(n)

    if (used > 0) {
      if (!destinationId) {
        throw new Error(
          `${found.name} is set on ${used} record${used === 1 ? '' : 's'}. Pick the stage they should move to before deleting it.`,
        )
      }
      const [destination] = await tx
        .select({ id: lifecycleStage.id })
        .from(lifecycleStage)
        .where(eq(lifecycleStage.id, destinationId))
        .limit(1)
      if (!destination) throw new Error('That destination stage no longer exists.')
      if (destination.id === id) throw new Error('A stage cannot be its own destination.')

      await tx.execute(sql`update contact set lifecycle_stage_id = ${destinationId}, updated_at = now() where lifecycle_stage_id = ${id}`)
      await tx.execute(sql`update company set lifecycle_stage_id = ${destinationId}, updated_at = now() where lifecycle_stage_id = ${id}`)
    }

    await tx.delete(lifecycleStage).where(eq(lifecycleStage.id, id))

    return {
      result: { moved: used },
      audit: {
        entity: 'lifecycle_stage',
        entityId: id,
        action: 'delete',
        before: { name: found.name, used },
        after: { movedTo: destinationId },
      },
    }
  })
