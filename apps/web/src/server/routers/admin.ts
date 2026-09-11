import {
  ACTION_TYPES,
  createCustomObject,
  deleteCustomObject,
  listCustomObjects,
  renameCustomObject,
  MAX_DELAY_MINUTES,
  AUTOMATION_TRIGGERS,
  FIELD_TYPES,
  OPERATORS,
  HUBS,
  listAutomationRuns,
  listAutomations,
  parseFilters,
  parseSteps,
  RUN_PAGE,
  readAutomation,
  removeAutomation,
  saveAutomation,
  setAutomationActive,
  auditEntities,
  deleteTeam,
  listAssignable,
  listAudit,
  listMembers,
  listTeams,
  saveTeam,
  setTeamMembers,
  createField,
  moveFieldsToGroup,
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
  renameFieldGroup,
  updateField,
  updateStage,
  updateSubscriptionType,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { adminProcedure, protectedProcedure, router } from '../trpc.ts'

/** Account configuration: the field registry, the pipelines, the lifecycle list
 *  and the subscription types.
 *
 *  Reads are open to anybody signed in, because every surface in the app already
 *  shows this configuration; hiding the settings page from a salesperson who can
 *  see the same stage names on a board would be theatre. Writes need the account
 *  hub here and are refused again by the data access layer's role matrix. */

/** Any object in the account, including one an admin invented: a field belongs
 *  to whichever object the registry says exists, and fields are the whole point
 *  of inventing one. Shaped-like-a-key only; the registry decides the rest. */
const objectKey = z.string().regex(/^[a-z][a-z0-9_]{1,58}$/, 'That is not an object.')

/** One rule's steps.
 *
 *  A discriminated union so a delay cannot arrive without its minutes and a
 *  branch cannot arrive without its arms. Twenty steps per list is more than any
 *  readable rule and well short of anything that could make the runner slow.
 *
 *  Written out level by level rather than declared recursive: the nesting the
 *  editor offers is bounded anyway, and three explicit levels type themselves
 *  where a lazy schema needs a cast to do the same job.
 *
 *  Filters arrive unknown and are parsed by the layer, which walks the arms once
 *  and refuses a condition no object can answer. */
const leafStep = [
  z.object({
    kind: z.literal('action'),
    type: z.enum(ACTION_TYPES),
    config: z.record(z.string().max(64), z.unknown()),
  }),
  z.object({ kind: z.literal('delay'), minutes: z.number().int().min(1).max(MAX_DELAY_MINUTES) }),
  z.object({ kind: z.literal('guard'), conditions: z.array(z.unknown()).max(10) }),
] as const

const branchOver = <T extends z.ZodType>(arm: T) =>
  z.object({
    kind: z.literal('branch'),
    conditions: z.array(z.unknown()).max(10),
    matched: z.array(arm).max(20),
    otherwise: z.array(arm).max(20),
  })

const deepest = z.discriminatedUnion('kind', [...leafStep])
const nested = z.discriminatedUnion('kind', [...leafStep, branchOver(deepest)])
const automationSteps = z
  .array(z.discriminatedUnion('kind', [...leafStep, branchOver(nested)]))
  .min(1)
  .max(20)

const name = z.string().trim().min(1).max(120)
const fieldType = z.enum(FIELD_TYPES as unknown as [string, ...string[]])

/** Conditional property logic: one group of conditions over sibling properties,
 *  in the shape the filter builder produces. Null clears the rule. */
const conditional = z
  .object({
    conjunction: z.enum(['and', 'or']),
    conditions: z
      .array(z.object({ field: z.string().max(59), operator: z.enum(OPERATORS), value: z.unknown().optional() }))
      .max(10),
  })
  .nullable()

export const adminRouter = router({
  members: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listMembers(ctx.account))),
    hubs: protectedProcedure.query(() => HUBS),
  }),

  /** Named groups inside this account. A team decides where a round-robin lead
   *  lands, so reading one is open and changing one is an admin's. */
  teams: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listTeams(ctx.account))),
    assignable: protectedProcedure.query(({ ctx }) => call(() => listAssignable(ctx.account))),
    save: adminProcedure
      .input(
        z.object({
          id: z.string().uuid().nullable().optional(),
          name,
          description: z.string().trim().max(500).nullable().optional(),
        }),
      )
      .mutation(({ ctx, input }) => call(() => saveTeam(ctx.account, input))),
    delete: adminProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteTeam(ctx.account, input.id))),
    setMembers: adminProcedure
      .input(
        z.object({
          teamId: z.string().uuid(),
          members: z.array(z.object({ userId: z.string().uuid(), isLead: z.boolean().optional() })).max(200),
        }),
      )
      .mutation(({ ctx, input }) => call(() => setTeamMembers(ctx.account, input))),
  }),

  /** Who changed what in this account. Admin only, and refused again in the
   *  data access layer, because a history is a security record. */
  audit: router({
    entities: adminProcedure.query(({ ctx }) => call(() => auditEntities(ctx.account))),
    list: adminProcedure
      .input(
        z
          .object({
            entity: z.string().max(64).nullable().optional(),
            actorId: z.string().uuid().nullable().optional(),
            from: z.string().datetime().nullable().optional(),
            to: z.string().datetime().nullable().optional(),
            limit: z.number().int().min(1).max(200).optional(),
            cursor: z.object({ at: z.string(), id: z.string().uuid() }).nullable().optional(),
          })
          .optional(),
      )
      .query(({ ctx, input }) => call(() => listAudit(ctx.account, input ?? {}))),
  }),

  /** Objects an admin invents. The three Rawr is built on are not here: they
   *  cannot be created, renamed or deleted, and the layer refuses each. */
  objects: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listCustomObjects(ctx.account))),

    create: adminProcedure
      .input(
        z.object({
          nameSingular: z.string().min(1).max(60),
          namePlural: z.string().min(1).max(60),
          labelFieldLabel: z.string().max(60).optional(),
        }),
      )
      .mutation(({ ctx, input }) => call(() => createCustomObject(ctx.account, input))),

    rename: adminProcedure
      .input(
        z.object({
          id: z.uuid(),
          nameSingular: z.string().min(1).max(60),
          namePlural: z.string().min(1).max(60),
        }),
      )
      .mutation(({ ctx, input: { id, ...names } }) =>
        call(() => renameCustomObject(ctx.account, id, names)),
      ),

    remove: adminProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteCustomObject(ctx.account, input.id))),
  }),

  fields: router({
    list: protectedProcedure
      .input(z.object({ object: objectKey.optional() }).optional())
      .query(({ ctx, input }) => call(() => listFields(ctx.account, input?.object))),

    listDeleted: adminProcedure.query(({ ctx }) => call(() => listDeletedFields(ctx.account))),

    types: protectedProcedure.query(() => FIELD_TYPES),

    create: adminProcedure
      .input(
        z.object({
          object: objectKey,
          key: z.string().trim().min(1).max(59),
          label: name,
          type: fieldType,
          options: z.array(z.string().max(120)).max(200).optional(),
          helpText: z.string().max(500).nullish(),
          groupName: z.string().trim().max(80).nullish(),
          conditional: conditional.optional(),
          isRequired: z.boolean().optional(),
          trackChanges: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          createField(ctx.account, {
            objectKey: input.object,
            key: input.key,
            label: input.label,
            type: input.type as never,
            ...(input.options ? { options: input.options } : {}),
            ...(input.helpText !== undefined ? { helpText: input.helpText } : {}),
            ...(input.groupName !== undefined ? { groupName: input.groupName } : {}),
            ...(input.conditional !== undefined ? { conditional: input.conditional } : {}),
            ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
            ...(input.trackChanges !== undefined ? { trackChanges: input.trackChanges } : {}),
          }),
        ),
      ),

    update: adminProcedure
      .input(
        z.object({
          id: z.uuid(),
          label: name.optional(),
          options: z.array(z.string().max(120)).max(200).optional(),
          helpText: z.string().max(500).nullish(),
          groupName: z.string().trim().max(80).nullish(),
          conditional: conditional.optional(),
          isRequired: z.boolean().optional(),
          trackChanges: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          updateField(ctx.account, {
            id: input.id,
            ...(input.label !== undefined ? { label: input.label } : {}),
            ...(input.options !== undefined ? { options: input.options } : {}),
            ...(input.helpText !== undefined ? { helpText: input.helpText } : {}),
            ...(input.groupName !== undefined ? { groupName: input.groupName } : {}),
            ...(input.conditional !== undefined ? { conditional: input.conditional } : {}),
            ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
            ...(input.trackChanges !== undefined ? { trackChanges: input.trackChanges } : {}),
          }),
        ),
      ),

    reorder: adminProcedure
      .input(z.object({ object: objectKey, orderedIds: z.array(z.uuid()).max(400) }))
      .mutation(({ ctx, input }) => call(() => reorderFields(ctx.account, input.object, input.orderedIds))),

    /** A group is its name and nothing else, so renaming one is renaming it on
     *  every property that sits under it. */
    renameGroup: adminProcedure
      .input(z.object({ object: objectKey, from: z.string().trim().min(1).max(80), to: z.string().trim().min(1).max(80) }))
      .mutation(({ ctx, input }) => call(() => renameFieldGroup(ctx.account, input.object, input.from, input.to))),

    /** Properties into a group, which is also how a group is created: naming one
     *  on the properties that belong to it is what makes it exist. */
    moveToGroup: adminProcedure
      .input(
        z.object({
          object: objectKey,
          fieldIds: z.array(z.uuid()).min(1).max(400),
          groupName: z.string().trim().max(80).nullable(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() => moveFieldsToGroup(ctx.account, input.object, input.fieldIds, input.groupName)),
      ),

    /** What a delete would hide, so the confirmation can say it out loud. */
    usage: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .query(({ ctx, input }) => call(() => fieldUsage(ctx.account, input.id))),

    remove: adminProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteField(ctx.account, input.id))),

    restore: adminProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => restoreField(ctx.account, input.id))),

    /** Gives a jsonb-stored field its own expression index, so filtering and
     *  sorting on it stops being a scan. The index itself is built by the worker:
     *  CREATE INDEX CONCURRENTLY cannot run inside a request. F0 §4. */
    promoteToHot: adminProcedure
      .input(z.object({ fieldId: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => promoteFieldToHot(ctx.account, input.fieldId))),

    /** The irreversible half, deliberately separate from delete. F0 §4. */
    purge: adminProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => purgeField(ctx.account, input.id))),
  }),

  pipelines: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listPipelines(ctx.account))),

    create: adminProcedure
      .input(z.object({ name }))
      .mutation(({ ctx, input }) => call(() => createPipeline(ctx.account, input.name))),

    rename: adminProcedure
      .input(z.object({ id: z.uuid(), name }))
      .mutation(({ ctx, input }) => call(() => renamePipeline(ctx.account, input.id, input.name))),

    remove: adminProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deletePipeline(ctx.account, input.id))),

    createStage: adminProcedure
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
          createStage(ctx.account, {
            pipelineId: input.pipelineId,
            name: input.name,
            ...(input.probability !== undefined ? { probability: input.probability } : {}),
            ...(input.isClosedWon !== undefined ? { isClosedWon: input.isClosedWon } : {}),
            ...(input.isClosedLost !== undefined ? { isClosedLost: input.isClosedLost } : {}),
          }),
        ),
      ),

    updateStage: adminProcedure
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
          updateStage(ctx.account, {
            id: input.id,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.probability !== undefined ? { probability: input.probability } : {}),
            ...(input.isClosedWon !== undefined ? { isClosedWon: input.isClosedWon } : {}),
            ...(input.isClosedLost !== undefined ? { isClosedLost: input.isClosedLost } : {}),
          }),
        ),
      ),

    reorderStages: adminProcedure
      .input(z.object({ pipelineId: z.uuid(), orderedIds: z.array(z.uuid()).max(100) }))
      .mutation(({ ctx, input }) =>
        call(() => reorderStages(ctx.account, input.pipelineId, input.orderedIds)),
      ),

    /** Deleting a stage with deals in it needs a destination, and every deal that
     *  moves writes its own stage_change. F1's edge-case table. */
    removeStage: adminProcedure
      .input(z.object({ id: z.uuid(), destinationStageId: z.uuid().nullish() }))
      .mutation(({ ctx, input }) =>
        call(() => deleteStage(ctx.account, input.id, input.destinationStageId ?? null)),
      ),
  }),

  lifecycle: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listLifecycleStages(ctx.account))),

    create: adminProcedure
      .input(z.object({ name }))
      .mutation(({ ctx, input }) => call(() => createLifecycleStage(ctx.account, input.name))),

    rename: adminProcedure
      .input(z.object({ id: z.uuid(), name }))
      .mutation(({ ctx, input }) => call(() => renameLifecycleStage(ctx.account, input.id, input.name))),

    reorder: adminProcedure
      .input(z.object({ orderedIds: z.array(z.uuid()).max(100) }))
      .mutation(({ ctx, input }) => call(() => reorderLifecycleStages(ctx.account, input.orderedIds))),

    remove: adminProcedure
      .input(z.object({ id: z.uuid(), destinationId: z.uuid().nullish() }))
      .mutation(({ ctx, input }) =>
        call(() => deleteLifecycleStage(ctx.account, input.id, input.destinationId ?? null)),
      ),
  }),

  /** B11. When this happens, do that. Writing a rule is an admin's: it writes to
   *  every record matching a filter, which is not a thing to hand to whoever can
   *  write one record. The rules and their run log read like any other list. */
  automations: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listAutomations(ctx.account))),

    get: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .query(({ ctx, input }) => call(() => readAutomation(ctx.account, input.id))),

    save: adminProcedure
      .input(
        z.object({
          id: z.uuid().nullish(),
          name: z.string().min(1).max(120),
          trigger: z.enum(AUTOMATION_TRIGGERS),
          object: objectKey,
          conditions: z.array(z.unknown()).max(10),
          /** What the trigger needs beyond the object: the date field and its
           *  offset, or the days of silence. Checked against the object at save,
           *  where the field can be named. */
          triggerConfig: z.record(z.string().max(32), z.unknown()).optional(),
          steps: automationSteps,
          isActive: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          saveAutomation(ctx.account, {
            id: input.id ?? null,
            name: input.name,
            trigger: input.trigger,
            objectKey: input.object,
            ...(input.triggerConfig ? { triggerConfig: input.triggerConfig } : {}),
            conditions: parseFilters(input.conditions),
            // The shape is the schema's business and the filters are the layer's:
            // a branch holds arms of steps holding guards holding conditions, and
            // parsing that on the way past is one recursion, not two.
            steps: parseSteps(input.steps),
            ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
          }),
        ),
      ),

    setActive: adminProcedure
      .input(z.object({ id: z.uuid(), isActive: z.boolean() }))
      .mutation(({ ctx, input }) => call(() => setAutomationActive(ctx.account, input.id, input.isActive))),

    remove: adminProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => removeAutomation(ctx.account, input.id))),

    runs: protectedProcedure
      .input(
        z
          .object({
            automationId: z.uuid().optional(),
            state: z.enum(['waiting', 'done', 'skipped', 'failed']).optional(),
            limit: z.number().int().min(1).max(RUN_PAGE).optional(),
            offset: z.number().int().min(0).optional(),
          })
          .optional(),
      )
      .query(({ ctx, input }) =>
        call(() =>
          listAutomationRuns(ctx.account, {
            ...(input?.automationId ? { automationId: input.automationId } : {}),
            ...(input?.state ? { state: input.state } : {}),
            ...(input?.limit ? { limit: input.limit } : {}),
            ...(input?.offset ? { offset: input.offset } : {}),
          }),
        ),
      ),
  }),

  subscriptionTypes: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listSubscriptionTypes(ctx.account))),

    create: adminProcedure
      .input(
        z.object({
          name,
          description: z.string().max(500).nullish(),
          isInternal: z.boolean().optional(),
          doubleOptIn: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          createSubscriptionType(ctx.account, {
            name: input.name,
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.isInternal !== undefined ? { isInternal: input.isInternal } : {}),
            ...(input.doubleOptIn !== undefined ? { doubleOptIn: input.doubleOptIn } : {}),
          }),
        ),
      ),

    update: adminProcedure
      .input(
        z.object({
          id: z.uuid(),
          name: name.optional(),
          description: z.string().max(500).nullish(),
          isInternal: z.boolean().optional(),
          doubleOptIn: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          updateSubscriptionType(ctx.account, {
            id: input.id,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.isInternal !== undefined ? { isInternal: input.isInternal } : {}),
            ...(input.doubleOptIn !== undefined ? { doubleOptIn: input.doubleOptIn } : {}),
          }),
        ),
      ),

    /** The opt-out count is echoed back so a stale page cannot discard consent it
     *  did not know about. */
    remove: adminProcedure
      .input(z.object({ id: z.uuid(), confirmUnsubscribes: z.number().int().min(0) }))
      .mutation(({ ctx, input }) =>
        call(() => deleteSubscriptionType(ctx.account, input.id, input.confirmUnsubscribes)),
      ),
  }),
})
