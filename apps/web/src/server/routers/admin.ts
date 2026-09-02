import {
  FIELD_TYPES,
  ROLES,
  addMember,
  listMembers,
  removeMember,
  setMemberRole,
  createField,
  createLifecycleStage,
  createPipeline,
  createStage,
  createSubscriptionType,
  deleteField,
  deleteLifecycleStage,
  deletePipeline,
  deleteStage,
  deleteSubscriptionType,
  fieldUsage,
  listDeletedFields,
  listFields,
  listLifecycleStages,
  listPipelines,
  listSubscriptionTypes,
  promoteFieldToHot,
  purgeField,
  renameLifecycleStage,
  renamePipeline,
  reorderFields,
  reorderLifecycleStages,
  reorderStages,
  restoreField,
  updateField,
  updateStage,
  updateSubscriptionType,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { adminProcedure, protectedProcedure, router } from '../trpc.ts'

/** Workspace configuration: the field registry, the pipelines, the lifecycle list
 *  and the subscription types.
 *
 *  Reads are open to anybody signed in, because every surface in the app already
 *  shows this configuration; hiding the settings page from a salesperson who can
 *  see the same stage names on a board would be theatre. Writes go through the data
 *  access layer's role matrix, which is the thing that actually decides. */

const objectKey = z.enum(['contact', 'company', 'deal'])
const name = z.string().trim().min(1).max(120)
const fieldType = z.enum(FIELD_TYPES as unknown as [string, ...string[]])

export const adminRouter = router({
  members: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listMembers(ctx.workspace))),
    roles: protectedProcedure.query(() => ROLES),
    add: adminProcedure
      .input(z.object({ email: z.string().trim().email().max(254), name: z.string().trim().max(120).optional(), role: z.enum(ROLES) }))
      .mutation(({ ctx, input }) => call(() => addMember(ctx.workspace, input))),
    setRole: adminProcedure
      .input(z.object({ userId: z.string().uuid(), role: z.enum(ROLES) }))
      .mutation(({ ctx, input }) => call(() => setMemberRole(ctx.workspace, input))),
    remove: adminProcedure
      .input(z.object({ userId: z.string().uuid() }))
      .mutation(({ ctx, input }) => call(() => removeMember(ctx.workspace, input.userId))),
  }),

  fields: router({
    list: protectedProcedure
      .input(z.object({ object: objectKey.optional() }).optional())
      .query(({ ctx, input }) => call(() => listFields(ctx.workspace, input?.object))),

    listDeleted: adminProcedure.query(({ ctx }) => call(() => listDeletedFields(ctx.workspace))),

    types: protectedProcedure.query(() => FIELD_TYPES),

    create: protectedProcedure
      .input(
        z.object({
          object: objectKey,
          key: z.string().trim().min(1).max(59),
          label: name,
          type: fieldType,
          options: z.array(z.string().max(120)).max(200).optional(),
          helpText: z.string().max(500).nullish(),
          isRequired: z.boolean().optional(),
          trackChanges: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          createField(ctx.workspace, {
            objectKey: input.object,
            key: input.key,
            label: input.label,
            type: input.type as never,
            ...(input.options ? { options: input.options } : {}),
            ...(input.helpText !== undefined ? { helpText: input.helpText } : {}),
            ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
            ...(input.trackChanges !== undefined ? { trackChanges: input.trackChanges } : {}),
          }),
        ),
      ),

    update: protectedProcedure
      .input(
        z.object({
          id: z.uuid(),
          label: name.optional(),
          options: z.array(z.string().max(120)).max(200).optional(),
          helpText: z.string().max(500).nullish(),
          isRequired: z.boolean().optional(),
          trackChanges: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          updateField(ctx.workspace, {
            id: input.id,
            ...(input.label !== undefined ? { label: input.label } : {}),
            ...(input.options !== undefined ? { options: input.options } : {}),
            ...(input.helpText !== undefined ? { helpText: input.helpText } : {}),
            ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
            ...(input.trackChanges !== undefined ? { trackChanges: input.trackChanges } : {}),
          }),
        ),
      ),

    reorder: protectedProcedure
      .input(z.object({ object: objectKey, orderedIds: z.array(z.uuid()).max(400) }))
      .mutation(({ ctx, input }) => call(() => reorderFields(ctx.workspace, input.object, input.orderedIds))),

    /** What a delete would hide, so the confirmation can say it out loud. */
    usage: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .query(({ ctx, input }) => call(() => fieldUsage(ctx.workspace, input.id))),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteField(ctx.workspace, input.id))),

    restore: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => restoreField(ctx.workspace, input.id))),

    /** Gives a jsonb-stored field its own expression index, so filtering and
     *  sorting on it stops being a scan. The index itself is built by the worker:
     *  CREATE INDEX CONCURRENTLY cannot run inside a request. F0 §4. */
    promoteToHot: protectedProcedure
      .input(z.object({ fieldId: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => promoteFieldToHot(ctx.workspace, input.fieldId))),

    /** The irreversible half, deliberately separate from delete. F0 §4. */
    purge: adminProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => purgeField(ctx.workspace, input.id))),
  }),

  pipelines: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listPipelines(ctx.workspace))),

    create: protectedProcedure
      .input(z.object({ name }))
      .mutation(({ ctx, input }) => call(() => createPipeline(ctx.workspace, input.name))),

    rename: protectedProcedure
      .input(z.object({ id: z.uuid(), name }))
      .mutation(({ ctx, input }) => call(() => renamePipeline(ctx.workspace, input.id, input.name))),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deletePipeline(ctx.workspace, input.id))),

    createStage: protectedProcedure
      .input(
        z.object({
          pipelineId: z.uuid(),
          name,
          probability: z.number().min(0).max(100).nullish(),
          isClosedWon: z.boolean().optional(),
          isClosedLost: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          createStage(ctx.workspace, {
            pipelineId: input.pipelineId,
            name: input.name,
            ...(input.probability !== undefined ? { probability: input.probability } : {}),
            ...(input.isClosedWon !== undefined ? { isClosedWon: input.isClosedWon } : {}),
            ...(input.isClosedLost !== undefined ? { isClosedLost: input.isClosedLost } : {}),
          }),
        ),
      ),

    updateStage: protectedProcedure
      .input(
        z.object({
          id: z.uuid(),
          name: name.optional(),
          probability: z.number().min(0).max(100).nullish(),
          isClosedWon: z.boolean().optional(),
          isClosedLost: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          updateStage(ctx.workspace, {
            id: input.id,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.probability !== undefined ? { probability: input.probability } : {}),
            ...(input.isClosedWon !== undefined ? { isClosedWon: input.isClosedWon } : {}),
            ...(input.isClosedLost !== undefined ? { isClosedLost: input.isClosedLost } : {}),
          }),
        ),
      ),

    reorderStages: protectedProcedure
      .input(z.object({ pipelineId: z.uuid(), orderedIds: z.array(z.uuid()).max(100) }))
      .mutation(({ ctx, input }) =>
        call(() => reorderStages(ctx.workspace, input.pipelineId, input.orderedIds)),
      ),

    /** Deleting a stage with deals in it needs a destination, and every deal that
     *  moves writes its own stage_change. F1's edge-case table. */
    removeStage: protectedProcedure
      .input(z.object({ id: z.uuid(), destinationStageId: z.uuid().nullish() }))
      .mutation(({ ctx, input }) =>
        call(() => deleteStage(ctx.workspace, input.id, input.destinationStageId ?? null)),
      ),
  }),

  lifecycle: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listLifecycleStages(ctx.workspace))),

    create: protectedProcedure
      .input(z.object({ name }))
      .mutation(({ ctx, input }) => call(() => createLifecycleStage(ctx.workspace, input.name))),

    rename: protectedProcedure
      .input(z.object({ id: z.uuid(), name }))
      .mutation(({ ctx, input }) => call(() => renameLifecycleStage(ctx.workspace, input.id, input.name))),

    reorder: protectedProcedure
      .input(z.object({ orderedIds: z.array(z.uuid()).max(100) }))
      .mutation(({ ctx, input }) => call(() => reorderLifecycleStages(ctx.workspace, input.orderedIds))),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid(), destinationId: z.uuid().nullish() }))
      .mutation(({ ctx, input }) =>
        call(() => deleteLifecycleStage(ctx.workspace, input.id, input.destinationId ?? null)),
      ),
  }),

  subscriptionTypes: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listSubscriptionTypes(ctx.workspace))),

    create: protectedProcedure
      .input(z.object({ name, description: z.string().max(500).nullish(), isInternal: z.boolean().optional() }))
      .mutation(({ ctx, input }) =>
        call(() =>
          createSubscriptionType(ctx.workspace, {
            name: input.name,
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.isInternal !== undefined ? { isInternal: input.isInternal } : {}),
          }),
        ),
      ),

    update: protectedProcedure
      .input(
        z.object({
          id: z.uuid(),
          name: name.optional(),
          description: z.string().max(500).nullish(),
          isInternal: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          updateSubscriptionType(ctx.workspace, {
            id: input.id,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.isInternal !== undefined ? { isInternal: input.isInternal } : {}),
          }),
        ),
      ),

    /** The opt-out count is echoed back so a stale page cannot discard consent it
     *  did not know about. */
    remove: protectedProcedure
      .input(z.object({ id: z.uuid(), confirmUnsubscribes: z.number().int().min(0) }))
      .mutation(({ ctx, input }) =>
        call(() => deleteSubscriptionType(ctx.workspace, input.id, input.confirmUnsubscribes)),
      ),
  }),
})
