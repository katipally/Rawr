import {
  ACTIVITY_GROUPS,
  associate,
  bulkUpdateRecords,
  logByHand,
  LOGGABLE_TYPES,
  createRecord,
  createTask,
  deleteLoggedEntry,
  deleteRecord,
  deleteTask,
  editLoggedEntry,
  deleteView,
  dissociate,
  dryRun,
  getRecord,
  getRegistry,
  isActivityType,
  listRecords,
  listTasks,
  listViews,
  mergeRecords,
  overdueNextSteps,
  readAssociations,
  readBoard,
  readImportRun,
  listImportRuns,
  readSubscriptions,
  readTimeline,
  recordOptions,
  runImportChunk,
  saveView,
  searchAll,
  setImportMapping,
  setSubscription,
  setTaskStatus,
  timelineCounts,
  updateRecord,
  withWorkspace,
  schema,
} from '@rawr/db'
import { asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { call } from '../errors.ts'
import { announceStageChange } from '../stage-alerts.ts'
import { protectedProcedure, router } from '../trpc.ts'

const objectKey = z.enum(['contact', 'company', 'deal'])
const entityRef = z.object({ entityType: objectKey, entityId: z.uuid() })

const condition = z.object({
  field: z.string().min(1).max(64),
  operator: z.string().min(1).max(24),
  value: z.unknown().optional(),
})
const filterGroup = z.object({
  conjunction: z.enum(['and', 'or']),
  conditions: z.array(condition).max(20),
})
const sortSchema = z.object({ key: z.string().min(1).max(64), direction: z.enum(['asc', 'desc']) })
const cursorSchema = z.object({ value: z.union([z.string(), z.number(), z.null()]), id: z.uuid() })

/** Values arrive as whatever a form produced. The registry decides what each one
 *  has to be, so there is nothing to validate here beyond the shape and the size. */
const recordValues = z.record(z.string().max(64), z.unknown())

const listInput = z.object({
  object: objectKey,
  columns: z.array(z.string().max(64)).max(60).optional(),
  filters: z.array(filterGroup).max(5).optional(),
  sorts: z.array(sortSchema).max(3).optional(),
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: cursorSchema.nullish(),
})

export const crmRouter = router({
  registry: protectedProcedure.query(({ ctx }) =>
    call(async () => {
      const registry = await getRegistry(ctx.workspace)
      return {
        objects: registry.objects.map((object) => ({
          id: object.id,
          key: object.key,
          nameSingular: object.nameSingular,
          namePlural: object.namePlural,
          icon: object.icon,
          fields: object.fields.map((field) => ({
            key: field.key,
            label: field.label,
            type: field.type,
            storage: field.storage,
            isRequired: field.isRequired,
            isCustom: field.isCustom,
            options: field.options,
            helpText: field.helpText,
            operators: field.operators,
          })),
        })),
        activityGroups: ACTIVITY_GROUPS,
      }
    }),
  ),

  /** Everything a picker needs, in one round trip, because a record page opens
   *  four of them at once. */
  lookups: protectedProcedure.query(({ ctx }) =>
    call(async () =>
      withWorkspace(ctx.workspace, async (tx) => {
        const [users, pipelines, stages, lifecycles] = await Promise.all([
          tx
            .select({ id: schema.userAccount.id, name: schema.userAccount.name, email: schema.userAccount.email })
            .from(schema.membership)
            .innerJoin(schema.userAccount, eq(schema.userAccount.id, schema.membership.userId))
            .orderBy(asc(schema.userAccount.name)),
          tx.select().from(schema.pipeline).orderBy(asc(schema.pipeline.position)),
          tx.select().from(schema.pipelineStage).orderBy(asc(schema.pipelineStage.position)),
          tx.select().from(schema.lifecycleStage).orderBy(asc(schema.lifecycleStage.position)),
        ])
        return {
          users,
          pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })),
          stages: stages.map((s) => ({
            id: s.id,
            pipelineId: s.pipelineId,
            name: s.name,
            probability: s.probability === null ? null : Number(s.probability),
            isClosedWon: s.isClosedWon,
            isClosedLost: s.isClosedLost,
          })),
          lifecycleStages: lifecycles.map((l) => ({ id: l.id, name: l.name })),
        }
      }),
    ),
  ),

  records: router({
    list: protectedProcedure.input(listInput).query(({ ctx, input }) =>
      call(() => listRecords(ctx.workspace, input as never)),
    ),

    get: protectedProcedure
      .input(z.object({ object: objectKey, id: z.uuid() }))
      .query(({ ctx, input }) => call(() => getRecord(ctx.workspace, input.object, input.id))),

    /** What every record picker reads. A capped, ranked answer to "which record
     *  did you mean", never the whole object. */
    options: protectedProcedure
      .input(
        z.object({
          object: objectKey,
          query: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(50).optional(),
          excludeId: z.uuid().nullish(),
        }),
      )
      .query(({ ctx, input }) =>
        call(() =>
          recordOptions(ctx.workspace, {
            object: input.object,
            query: input.query ?? '',
            limit: input.limit ?? 20,
            excludeId: input.excludeId ?? null,
          }),
        ),
      ),

    create: protectedProcedure
      .input(z.object({ object: objectKey, values: recordValues }))
      .mutation(({ ctx, input }) => call(() => createRecord(ctx.workspace, input.object, input.values))),

    update: protectedProcedure
      .input(
        z.object({
          object: objectKey,
          id: z.uuid(),
          values: recordValues,
          /** Sent by every editor. A stale write is refused rather than silently
           *  overwriting whoever saved in between. */
          expectedUpdatedAt: z.coerce.date().nullish(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(async () => {
          const result = await updateRecord(
            ctx.workspace,
            input.object,
            input.id,
            input.values,
            input.expectedUpdatedAt ?? null,
          )
          announceStageChange(ctx.workspace, ctx.session.workspaceSlug, result.stageChange, ctx.session.displayName)
          return result
        }),
      ),

    /** One field set applied to a selection. A row that refuses the change is
     *  named back rather than failing the whole run. A5. */
    bulkUpdate: protectedProcedure
      .input(
        z.object({
          object: objectKey,
          ids: z.array(z.uuid()).min(1).max(500),
          values: recordValues,
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() => bulkUpdateRecords(ctx.workspace, input.object, input.ids, input.values)),
      ),

    remove: protectedProcedure
      .input(z.object({ object: objectKey, id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteRecord(ctx.workspace, input.object, input.id))),

    merge: protectedProcedure
      .input(
        z.object({
          object: objectKey,
          survivorId: z.uuid(),
          absorbedId: z.uuid(),
          picks: z.record(z.string().max(64), z.enum(['survivor', 'absorbed'])),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          mergeRecords(ctx.workspace, {
            objectKey: input.object,
            survivorId: input.survivorId,
            absorbedId: input.absorbedId,
            picks: input.picks,
          }),
        ),
      ),
  }),

  views: router({
    list: protectedProcedure
      .input(z.object({ object: objectKey }))
      .query(({ ctx, input }) => call(() => listViews(ctx.workspace, input.object))),

    save: protectedProcedure
      .input(
        z.object({
          object: objectKey,
          id: z.uuid().nullish(),
          name: z.string().trim().min(1).max(80),
          kind: z.enum(['table', 'board']),
          columns: z.array(z.string().max(64)).min(1).max(60),
          filters: z.array(filterGroup).max(5),
          sorts: z.array(sortSchema).max(3),
          isShared: z.boolean(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          saveView(ctx.workspace, {
            objectKey: input.object,
            id: input.id ?? null,
            name: input.name,
            kind: input.kind,
            columns: input.columns,
            filters: input.filters as never,
            sorts: input.sorts,
            isShared: input.isShared,
          }),
        ),
      ),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteView(ctx.workspace, input.id))),
  }),

  board: router({
    read: protectedProcedure
      .input(
        z.object({
          pipelineId: z.uuid().nullish(),
          filters: z.array(filterGroup).max(5).optional(),
          search: z.string().max(200).optional(),
          groupBy: z.string().max(64).nullish(),
        }),
      )
      .query(({ ctx, input }) =>
        call(() =>
          readBoard(ctx.workspace, {
            pipelineId: input.pipelineId ?? null,
            filters: (input.filters ?? []) as never,
            search: input.search ?? '',
            groupBy: input.groupBy ?? null,
          }),
        ),
      ),

    /** Dragging a card is an ordinary field write, so it goes through the same
     *  path and writes the same stage_change activity. The field comes from which
     *  board is on screen; the registry refuses anything it does not know, so
     *  nothing here has to guess what is writable. */
    moveCard: protectedProcedure
      .input(
        z.object({
          dealId: z.uuid(),
          field: z.string().min(1).max(64),
          value: z.string().min(1).max(200),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(async () => {
          const result = await updateRecord(ctx.workspace, 'deal', input.dealId, {
            [input.field]: input.value,
          })
          announceStageChange(ctx.workspace, ctx.session.workspaceSlug, result.stageChange, ctx.session.displayName)
          return result
        }),
      ),
  }),

  timeline: router({
    list: protectedProcedure
      .input(
        z.object({
          entity: entityRef,
          types: z.array(z.string().max(32)).max(24).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          cursor: z.object({ occurredAt: z.coerce.date(), id: z.uuid() }).nullish(),
        }),
      )
      .query(({ ctx, input }) =>
        call(() =>
          readTimeline(ctx.workspace, {
            entity: input.entity,
            types: (input.types ?? []).filter(isActivityType),
            limit: input.limit ?? 50,
            cursor: input.cursor ?? null,
          }),
        ),
      ),

    counts: protectedProcedure
      .input(z.object({ entity: entityRef }))
      .query(({ ctx, input }) => call(() => timelineCounts(ctx.workspace, input.entity))),

    log: protectedProcedure
      .input(
        z.object({
          entity: entityRef,
          type: z.enum(LOGGABLE_TYPES),
          body: z.string().trim().min(1).max(20_000),
          // A call is logged after it happened. Absent means now.
          occurredAt: z.coerce.date().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          logByHand(ctx.workspace, {
            entity: input.entity,
            type: input.type,
            body: input.body,
            ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
          }),
        ),
      ),

    edit: protectedProcedure
      .input(z.object({ id: z.uuid(), body: z.string().trim().min(1).max(20_000) }))
      .mutation(({ ctx, input }) => call(() => editLoggedEntry(ctx.workspace, input))),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteLoggedEntry(ctx.workspace, input.id))),
  }),

  associations: router({
    read: protectedProcedure
      .input(z.object({ entity: entityRef }))
      .query(({ ctx, input }) => call(() => readAssociations(ctx.workspace, input.entity))),

    add: protectedProcedure
      .input(z.object({ a: entityRef, b: entityRef, label: z.string().max(80).nullish() }))
      .mutation(({ ctx, input }) =>
        call(() => associate(ctx.workspace, input.a, input.b, input.label ?? null)),
      ),

    remove: protectedProcedure
      .input(z.object({ a: entityRef, b: entityRef }))
      .mutation(({ ctx, input }) => call(() => dissociate(ctx.workspace, input.a, input.b))),
  }),

  tasks: router({
    list: protectedProcedure
      .input(
        z.object({
          status: z.enum(['open', 'done']).optional(),
          assigneeId: z.uuid().optional(),
          overdueOnly: z.boolean().optional(),
          entity: entityRef.optional(),
        }),
      )
      .query(({ ctx, input }) => call(() => listTasks(ctx.workspace, input))),

    create: protectedProcedure
      .input(
        z.object({
          title: z.string().trim().min(1).max(300),
          body: z.string().max(20_000).nullish(),
          dueDate: z.iso.date().nullish(),
          assigneeId: z.uuid().nullish(),
          entity: entityRef.nullish(),
        }),
      )
      .mutation(({ ctx, input }) => call(() => createTask(ctx.workspace, input))),

    setStatus: protectedProcedure
      .input(z.object({ id: z.uuid(), status: z.enum(['open', 'done']) }))
      .mutation(({ ctx, input }) => call(() => setTaskStatus(ctx.workspace, input.id, input.status))),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteTask(ctx.workspace, input.id))),

    overdueNextSteps: protectedProcedure.query(({ ctx }) =>
      call(() => overdueNextSteps(ctx.workspace)),
    ),
  }),

  subscriptions: router({
    read: protectedProcedure
      .input(z.object({ contactId: z.uuid() }))
      .query(({ ctx, input }) => call(() => readSubscriptions(ctx.workspace, input.contactId))),

    set: protectedProcedure
      .input(
        z.object({
          contactId: z.uuid(),
          typeId: z.uuid(),
          state: z.enum(['subscribed', 'unsubscribed', 'unspecified']),
        }),
      )
      .mutation(({ ctx, input }) => call(() => setSubscription(ctx.workspace, input))),
  }),

  search: protectedProcedure
    .input(z.object({ query: z.string().max(200) }))
    .query(({ ctx, input }) => call(() => searchAll(ctx.workspace, input.query))),

  imports: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listImportRuns(ctx.workspace))),

    read: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .query(({ ctx, input }) => call(() => readImportRun(ctx.workspace, input.id))),

    setMapping: protectedProcedure
      .input(z.object({ id: z.uuid(), mapping: z.record(z.string(), z.string().nullable()) }))
      .mutation(({ ctx, input }) => call(() => setImportMapping(ctx.workspace, input.id, input.mapping))),

    dryRun: protectedProcedure
      .input(
        z.object({
          object: objectKey,
          mapping: z.record(z.string(), z.string().nullable()),
          rows: z.array(z.record(z.string(), z.string())).max(5000),
        }),
      )
      .query(({ ctx, input }) =>
        call(() => dryRun(ctx.workspace, { objectKey: input.object, mapping: input.mapping, rows: input.rows })),
      ),

    /** One chunk per call. The page polls, so closing the tab does not stop it and
     *  reopening the page shows where it got to. */
    runChunk: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => runImportChunk(ctx.workspace, input.id))),
  }),

  /** Used by the duplicate banner: given an id, what is it called. */
  nameOf: protectedProcedure
    .input(z.object({ object: objectKey, id: z.uuid() }))
    .query(({ ctx, input }) =>
      call(async () => {
        const record = await getRecord(ctx.workspace, input.object, input.id)
        return record?.displayName ?? null
      }),
    ),

  countsByObject: protectedProcedure.query(({ ctx }) =>
    call(() =>
      withWorkspace(ctx.workspace, async (tx) => {
        const rows = await tx.execute<{ object_key: string; n: number }>(sql`
          select 'contact' as object_key, count(*)::int as n from contact where deleted_at is null
          union all select 'company', count(*)::int from company where deleted_at is null
          union all select 'deal', count(*)::int from deal where deleted_at is null`)
        return Object.fromEntries(rows.map((row) => [row.object_key, Number(row.n)]))
      }),
    ),
  ),
})
