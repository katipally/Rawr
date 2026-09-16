import {
  ACTIVITY_GROUPS,
  FIELD_TYPES,
  associate,
  bulkUpdateRecords,
  readBulkOperation,
  startBulkOperation,
  logByHand,
  LOGGABLE_TYPES,
  createRecord,
  createTask,
  createTaskQueue,
  deleteLoggedEntry,
  deleteRecord,
  deleteTask,
  deleteTaskQueue,
  editLoggedEntry,
  deleteView,
  duplicateView,
  dissociate,
  previewImportRun,
  beginImportRun,
  appendImportRows,
  finishImportRun,
  IMPORT_KINDS,
  MAX_CHOICES,
  MAX_OPTION_LENGTH,
  dismissDuplicate,
  findDuplicates,
  getRecord,
  getRegistry,
  isActivityType,
  listKpis,
  listRecords,
  listTasks,
  listTaskQueues,
  listViews,
  mergeRecords,
  overdueNextSteps,
  readAssociations,
  renameTaskQueue,
  renameView,
  reorderViews,
  setViewPinned,
  assertCanAttach,
  listAttachments,
  MAX_ATTACHMENT_BYTES,
  readAttachment,
  readBoard,
  readBoardColumn,
  recordAttachment,
  removeAttachment,
  storageKeyFor,
  readCalendar,
  readImportRun,
  listImportRuns,
  readSubscriptions,
  readTimeline,
  recordOptions,
  cancelImportRun,
  unfinishedImportUploads,
  UPLOAD_PART_BYTES,
  startImportRun,
  saveView,
  searchAll,
  setImportMapping,
  setSubscription,
  setTaskStatus,
  timelineCounts,
  updateRecord,
  updateTask,
  withAccount,
  schema,
  type UpdateResult,
  type AccountContext,
} from '@rawr/db'
import { reportEvent } from '../automations.ts'
import { propagateSubscriptionToBrevo } from '../integrations/brevo.ts'
import { asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { call } from '../errors.ts'
import { discardUpload, sealUpload, startUpload } from '../import-upload.ts'
import { announceStageChange } from '../stage-alerts.ts'
import { NOT_CONFIGURED, removeObject, signedDownload, storageConfigured } from '../storage.ts'
import { protectedProcedure, router } from '../trpc.ts'

/** The three the system is built on. Used only where a procedure genuinely needs
 *  one: merging two records and importing a file both work off a shape that is
 *  written out per object, and neither has a general form. Everything else takes
 *  `anyObject` and asks the registry. */
const objectKey = z.enum(['contact', 'company', 'deal'])

/** Any object in the account, including one an admin invented. The registry is
 *  what decides whether it exists — this only proves the string is shaped like a
 *  key, because it reaches SQL as an alias and appears in a URL. */
const anyObject = z.string().regex(/^[a-z][a-z0-9_]{1,58}$/, 'That is not an object.')
const entityRef = z.object({ entityType: anyObject, entityId: z.uuid() })

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
  object: anyObject,
  columns: z.array(z.string().max(64)).max(60).optional(),
  filters: z.array(filterGroup).max(5).optional(),
  sorts: z.array(sortSchema).max(3).optional(),
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: cursorSchema.nullish(),
})

/** A stage move and a lifecycle move are two triggers on one write, so both are
 *  read off the same result rather than from two separate calls. `updateRecord`
 *  reports exactly one of them per write, because they are different columns. */
const fireChangeAutomations = (
  ctx: { account: AccountContext; session: { accountSlug: string } },
  // Any object: a custom one has no stage or lifecycle, so `trigger` below is
  // null for it and this returns before reportEvent is reached at all.
  object: string,
  id: string,
  result: UpdateResult,
): void => {
  const trigger = result.stageChange ? 'stage_changed' : result.lifecycleChanged ? 'lifecycle_changed' : null
  if (!trigger) return
  reportEvent(ctx.account, {
    trigger,
    objectKey: object,
    entityId: id,
    displayName: result.displayName,
    accountSlug: ctx.session.accountSlug,
  })
}

export const crmRouter = router({
  registry: protectedProcedure.query(({ ctx }) =>
    call(async () => {
      const registry = await getRegistry(ctx.account)
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
      withAccount(ctx.account, async (tx) => {
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
      call(() => listRecords(ctx.account, input as never)),
    ),

    get: protectedProcedure
      .input(z.object({ object: anyObject, id: z.uuid() }))
      .query(({ ctx, input }) => call(() => getRecord(ctx.account, input.object, input.id))),

    /** What every record picker reads. A capped, ranked answer to "which record
     *  did you mean", never the whole object. */
    /** The relation picker. Any object: what a record is called in a picker is a
     *  per-object expression, and the registry supplies it for an invented one. */
    options: protectedProcedure
      .input(
        z.object({
          object: anyObject,
          query: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(50).optional(),
          excludeId: z.uuid().nullish(),
        }),
      )
      .query(({ ctx, input }) =>
        call(() =>
          recordOptions(ctx.account, {
            object: input.object,
            query: input.query ?? '',
            limit: input.limit ?? 20,
            excludeId: input.excludeId ?? null,
          }),
        ),
      ),

    create: protectedProcedure
      .input(z.object({ object: anyObject, values: recordValues }))
      .mutation(({ ctx, input }) =>
        call(async () => {
          const result = await createRecord(ctx.account, input.object, input.values)
          reportEvent(ctx.account, {
            trigger: 'record_created',
            objectKey: input.object,
            entityId: result.id,
            displayName: result.displayName,
            accountSlug: ctx.session.accountSlug,
          })
          return result
        }),
      ),

    update: protectedProcedure
      .input(
        z.object({
          object: anyObject,
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
            ctx.account,
            input.object,
            input.id,
            input.values,
            input.expectedUpdatedAt ?? null,
          )
          announceStageChange(ctx.account, ctx.session.accountSlug, result.stageChange, ctx.session.displayName)
          fireChangeAutomations(ctx, input.object, input.id, result)
          return result
        }),
      ),

    /** One field set applied to a selection. A row that refuses the change is
     *  named back rather than failing the whole run. A5. */
    bulkUpdate: protectedProcedure
      .input(
        z.object({
          object: anyObject,
          ids: z.array(z.uuid()).min(1).max(500),
          values: recordValues,
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() => bulkUpdateRecords(ctx.account, input.object, input.ids, input.values)),
      ),

    remove: protectedProcedure
      .input(z.object({ object: anyObject, id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteRecord(ctx.account, input.object, input.id))),

    /** The review queue behind the merge dialog. Read-only, gated on write: it
     *  lists two records side by side asserting they might be one person, which
     *  is not a thing to put in front of somebody who cannot act on it. */
    duplicates: protectedProcedure
      .input(z.object({ object: z.enum(['contact', 'company']), limit: z.number().int().min(1).max(200).optional() }))
      .query(({ ctx, input }) =>
        call(() => findDuplicates(ctx.account, input.object, input.limit ? { limit: input.limit } : {})),
      ),

    /** "Not the same", kept. The queue is a scan, so without a row the same pair
     *  comes back on the next visit. */
    dismissDuplicate: protectedProcedure
      .input(
        z.object({
          object: z.enum(['contact', 'company']),
          leftId: z.uuid(),
          rightId: z.uuid(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() => dismissDuplicate(ctx.account, input.object, input)),
      ),

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
          mergeRecords(ctx.account, {
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
      .input(z.object({ object: anyObject }))
      .query(({ ctx, input }) => call(() => listViews(ctx.account, input.object))),

    save: protectedProcedure
      .input(
        z.object({
          object: anyObject,
          id: z.uuid().nullish(),
          name: z.string().trim().min(1).max(80),
          kind: z.enum(['table', 'board', 'calendar']),
          columns: z.array(z.string().max(64)).min(1).max(60),
          filters: z.array(filterGroup).max(5),
          sorts: z.array(sortSchema).max(3),
          isShared: z.boolean(),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          saveView(ctx.account, {
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

    rename: protectedProcedure
      .input(z.object({ id: z.uuid(), name: z.string().trim().min(1).max(80) }))
      .mutation(({ ctx, input }) => call(() => renameView(ctx.account, input.id, input.name))),

    duplicate: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => duplicateView(ctx.account, input.id))),

    pin: protectedProcedure
      .input(z.object({ id: z.uuid(), pinned: z.boolean() }))
      .mutation(({ ctx, input }) => call(() => setViewPinned(ctx.account, input.id, input.pinned))),

    reorder: protectedProcedure
      .input(z.object({ object: anyObject, ids: z.array(z.uuid()).min(1).max(100) }))
      .mutation(({ ctx, input }) => call(() => reorderViews(ctx.account, input.object, input.ids))),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteView(ctx.account, input.id))),
  }),

  /** The strip above a list: four counts of what is missing, each a link back to
   *  this view with one more filter on it. Its own round trip rather than part of
   *  the page, so four counts over eighty-eight thousand rows never hold up the
   *  rows themselves. */
  kpis: protectedProcedure
    .input(
      z.object({
        object: anyObject,
        filters: z.array(filterGroup).max(5).optional(),
        search: z.string().max(200).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      call(() => listKpis(ctx.account, input.object, (input.filters ?? []) as never, input.search ?? '')),
    ),

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
          readBoard(ctx.account, {
            pipelineId: input.pipelineId ?? null,
            filters: (input.filters ?? []) as never,
            search: input.search ?? '',
            groupBy: input.groupBy ?? null,
          }),
        ),
      ),

    /** The next page of one column. The board's own read caps every column, so
     *  this takes the same filters back and asks for what came after. */
    more: protectedProcedure
      .input(
        z.object({
          pipelineId: z.uuid().nullish(),
          filters: z.array(filterGroup).max(5).optional(),
          search: z.string().max(200).optional(),
          groupBy: z.string().max(64).nullish(),
          groupKey: z.string().min(1).max(200),
          offset: z.number().int().min(0).max(100_000),
        }),
      )
      .query(({ ctx, input }) =>
        call(() =>
          readBoardColumn(ctx.account, {
            pipelineId: input.pipelineId ?? null,
            filters: (input.filters ?? []) as never,
            search: input.search ?? '',
            groupBy: input.groupBy ?? null,
            groupKey: input.groupKey,
            offset: input.offset,
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
          const result = await updateRecord(ctx.account, 'deal', input.dealId, {
            [input.field]: input.value,
          })
          announceStageChange(ctx.account, ctx.session.accountSlug, result.stageChange, ctx.session.displayName)
          fireChangeAutomations(ctx, 'deal', input.dealId, result)
          return result
        }),
      ),
  }),

  /** Files on a record.
   *
   *  Three calls, in this order, and the order is the design. `sign` checks the
   *  role and the size and hands back a URL scoped to one key; the browser PUTs
   *  the bytes straight to storage; `confirm` writes the row. A row therefore
   *  never exists for a file that did not land, which is the failure that leaves
   *  a filename somebody can click and nothing behind it. */
  attachments: router({
    list: protectedProcedure
      .input(z.object({ entityType: anyObject, entityId: z.uuid() }))
      .query(({ ctx, input }) =>
        call(async () => ({
          configured: storageConfigured,
          rows: storageConfigured ? await listAttachments(ctx.account, input) : [],
        })),
      ),

    /** Names where the bytes will go and refuses everything refusable before any
     *  of them move. The upload itself is a POST to /api/attachments/upload with
     *  this key, because a browser cannot reach the bucket from this origin. */
    begin: protectedProcedure
      .input(
        z.object({
          entityType: anyObject,
          entityId: z.uuid(),
          filename: z.string().min(1).max(255),
          bytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
          mime: z.string().max(120),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(async () => {
          if (!storageConfigured) throw new Error(NOT_CONFIGURED)
          // Both refusals happen before a byte moves, so somebody is told while
          // they are still looking at the dialog rather than after the wait.
          assertCanAttach(ctx.account, input.bytes)
          return { storageKey: storageKeyFor(ctx.account, input) }
        }),
      ),

    confirm: protectedProcedure
      .input(
        z.object({
          entityType: anyObject,
          entityId: z.uuid(),
          storageKey: z.string().min(1).max(500),
          filename: z.string().min(1).max(255),
          bytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
          mime: z.string().max(120),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(async () => {
          // The key is rebuilt from the account on the session, so a client
          // cannot confirm a row against a path in somebody else's prefix.
          if (!input.storageKey.startsWith(`${ctx.account.accountId}/`)) {
            throw new Error('That file does not belong to this account.')
          }
          return recordAttachment(ctx.account, input)
        }),
      ),

    /** A link that stops working, minted per click. The row is read first, which
     *  is what proves the key belongs to this account before one is issued. */
    link: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) =>
        call(async () => {
          const row = await readAttachment(ctx.account, input.id)
          if (!row) throw new Error('That file is gone.')
          return { url: await signedDownload(row.storageKey, 120, row.filename) }
        }),
      ),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) =>
        call(async () => {
          const { storageKey } = await removeAttachment(ctx.account, input.id)
          // The row went first. Bytes left behind are invisible and cost pennies;
          // a row pointing at nothing is a broken link on a record, so of the two
          // ways for this to fail halfway, this is the better one.
          await removeObject(storageKey).catch(() => {})
        }),
      ),
  }),

  /** The third way to look at a list: placed on days by a date field. Read-only,
   *  because moving a record to another square is editing a date and the record
   *  page and the table already do that with the validation and the audit row a
   *  drag here would have to duplicate. */
  calendar: router({
    read: protectedProcedure
      .input(
        z.object({
          object: anyObject,
          /** Any day in the month wanted. The layer takes the month from it. */
          month: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, 'A month looks like 2026-09.'),
          field: z.string().min(1).max(64),
          filters: z.array(filterGroup).max(5).optional(),
          search: z.string().max(200).optional(),
        }),
      )
      .query(({ ctx, input }) =>
        call(() =>
          readCalendar(ctx.account, {
            object: input.object,
            month: input.month.length === 7 ? `${input.month}-01` : input.month,
            fieldKey: input.field,
            filters: (input.filters ?? []) as never,
            search: input.search ?? '',
          }),
        ),
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
          readTimeline(ctx.account, {
            entity: input.entity,
            types: (input.types ?? []).filter(isActivityType),
            limit: input.limit ?? 50,
            cursor: input.cursor ?? null,
          }),
        ),
      ),

    counts: protectedProcedure
      .input(z.object({ entity: entityRef }))
      .query(({ ctx, input }) => call(() => timelineCounts(ctx.account, input.entity))),

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
          logByHand(ctx.account, {
            entity: input.entity,
            type: input.type,
            body: input.body,
            ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
          }),
        ),
      ),

    edit: protectedProcedure
      .input(z.object({ id: z.uuid(), body: z.string().trim().min(1).max(20_000) }))
      .mutation(({ ctx, input }) => call(() => editLoggedEntry(ctx.account, input))),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteLoggedEntry(ctx.account, input.id))),
  }),

  associations: router({
    read: protectedProcedure
      .input(
        z.object({
          entity: entityRef,
          q: z.string().max(200).optional(),
          sort: z.enum(['recent', 'name']).optional(),
        }),
      )
      .query(({ ctx, input }) =>
        call(() => readAssociations(ctx.account, input.entity, { q: input.q, sort: input.sort })),
      ),

    add: protectedProcedure
      .input(z.object({ a: entityRef, b: entityRef, label: z.string().max(80).nullish() }))
      .mutation(({ ctx, input }) =>
        call(() => associate(ctx.account, input.a, input.b, input.label ?? null)),
      ),

    remove: protectedProcedure
      .input(z.object({ a: entityRef, b: entityRef }))
      .mutation(({ ctx, input }) => call(() => dissociate(ctx.account, input.a, input.b))),
  }),

  /** The bulk bar. One selection, one action, and the same DAL a single edit
   *  goes through, so a bulk delete is the same soft delete with the same audit
   *  row. Past the DAL's inline threshold the action is written down and the
   *  worker runs it in chunks, because a person who has selected eighty thousand
   *  records is not going to sit and watch. */
  bulk: router({
    start: protectedProcedure
      .input(
        z.object({
          object: anyObject,
          ids: z.array(z.uuid()).min(1).max(50_000),
          action: z.discriminatedUnion('type', [
            z.object({ type: z.literal('delete') }),
            z.object({ type: z.literal('assign'), ownerId: z.uuid().nullable() }),
            z.object({
              type: z.literal('associate'),
              target: entityRef,
              label: z.string().max(80).nullish(),
            }),
            z.object({ type: z.literal('add_to_list'), listId: z.uuid() }),
            z.object({ type: z.literal('merge'), survivorId: z.uuid() }),
          ]),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          startBulkOperation(ctx.account, {
            objectKey: input.object,
            ids: input.ids,
            action: input.action as never,
          }),
        ),
      ),

    progress: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .query(({ ctx, input }) => call(() => readBulkOperation(ctx.account, input.id))),
  }),

  tasks: router({
    list: protectedProcedure
      .input(
        z.object({
          status: z.enum(['open', 'done']).optional(),
          assigneeId: z.uuid().optional(),
          overdueOnly: z.boolean().optional(),
          due: z.enum(['today', 'upcoming']).optional(),
          entity: entityRef.optional(),
          type: z.enum(schema.TASK_TYPES).optional(),
          queueId: z.union([z.uuid(), z.literal('none')]).optional(),
        }),
      )
      .query(({ ctx, input }) => call(() => listTasks(ctx.account, input))),

    create: protectedProcedure
      .input(
        z.object({
          title: z.string().trim().min(1).max(300),
          body: z.string().max(20_000).nullish(),
          type: z.enum(schema.TASK_TYPES).optional(),
          priority: z.enum(schema.TASK_PRIORITIES).optional(),
          dueDate: z.iso.date().nullish(),
          remindAt: z.coerce.date().nullish(),
          queueId: z.uuid().nullish(),
          assigneeId: z.uuid().nullish(),
          entity: entityRef.nullish(),
        }),
      )
      .mutation(({ ctx, input }) => call(() => createTask(ctx.account, input))),

    update: protectedProcedure
      .input(
        z.object({
          id: z.uuid(),
          title: z.string().trim().min(1).max(300).optional(),
          body: z.string().max(20_000).nullish(),
          type: z.enum(schema.TASK_TYPES).optional(),
          priority: z.enum(schema.TASK_PRIORITIES).optional(),
          dueDate: z.iso.date().nullish(),
          remindAt: z.coerce.date().nullish(),
          queueId: z.uuid().nullish(),
          assigneeId: z.uuid().nullish(),
        }),
      )
      .mutation(({ ctx, input }) => call(() => updateTask(ctx.account, input))),

    queues: router({
      list: protectedProcedure.query(({ ctx }) => call(() => listTaskQueues(ctx.account))),

      create: protectedProcedure
        .input(z.object({ name: z.string().trim().min(1).max(120) }))
        .mutation(({ ctx, input }) => call(() => createTaskQueue(ctx.account, input.name))),

      rename: protectedProcedure
        .input(z.object({ id: z.uuid(), name: z.string().trim().min(1).max(120) }))
        .mutation(({ ctx, input }) => call(() => renameTaskQueue(ctx.account, input.id, input.name))),

      remove: protectedProcedure
        .input(z.object({ id: z.uuid() }))
        .mutation(({ ctx, input }) => call(() => deleteTaskQueue(ctx.account, input.id))),
    }),

    setStatus: protectedProcedure
      .input(z.object({ id: z.uuid(), status: z.enum(['open', 'done']) }))
      .mutation(({ ctx, input }) => call(() => setTaskStatus(ctx.account, input.id, input.status))),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteTask(ctx.account, input.id))),

    overdueNextSteps: protectedProcedure.query(({ ctx }) =>
      call(() => overdueNextSteps(ctx.account)),
    ),
  }),

  subscriptions: router({
    read: protectedProcedure
      .input(z.object({ contactId: z.uuid() }))
      .query(({ ctx, input }) => call(() => readSubscriptions(ctx.account, input.contactId))),

    set: protectedProcedure
      .input(
        z.object({
          contactId: z.uuid(),
          typeId: z.uuid(),
          state: z.enum(['subscribed', 'unsubscribed', 'unspecified']),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(async () => {
          await setSubscription(ctx.account, input)
          // After the write, never before: Brevo being down must not block a
          // person from recording an opt-out. Every failure inside is already a
          // dead letter with a replay path, so the throw is caught here and the
          // choice still lands rather than being lost with the request.
          await propagateSubscriptionToBrevo(ctx.account, input).catch(() => undefined)
        }),
      ),
  }),

  search: protectedProcedure
    .input(z.object({ query: z.string().max(200) }))
    .query(({ ctx, input }) => call(() => searchAll(ctx.account, input.query))),

  imports: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listImportRuns(ctx.account))),

    read: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .query(({ ctx, input }) => call(() => readImportRun(ctx.account, input.id))),

    /** What is still half uploaded, so somebody coming back is offered the file
     *  they left rather than having to remember it. */
    unfinished: protectedProcedure.query(({ ctx }) =>
      call(async () =>
        (await unfinishedImportUploads(ctx.account)).map((run) => ({
          id: run.id,
          filename: run.filename,
          fileBytes: run.fileBytes,
          uploadedBytes: run.uploadedBytes,
          /** The parts storage already holds, and the size it holds them in. The
           *  browser decides neither: it sends what is missing, in the size the
           *  run was started with. */
          have: run.parts.map((part) => part.n),
          partBytes: UPLOAD_PART_BYTES,
        })),
      ),
    ),

    /** The file goes to storage a part at a time and the server reads it. The
     *  parts themselves go to /api/imports/part, which takes bytes; these three
     *  are the bookkeeping either side of them. */
    beginUpload: protectedProcedure
      .input(
        z.object({
          // An object's key, or one of the five shape files the picker also offers.
          what: z.string().min(1).max(64),
          source: z.string().max(40).nullable(),
          filename: z.string().trim().min(1).max(255),
          fileBytes: z.number().int().positive(),
        }),
      )
      .mutation(({ ctx, input }) => call(() => startUpload(ctx.account, input))),

    finishUpload: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => sealUpload(ctx.account, input.id))),

    /** Stopping an upload, and taking its half-sent file out of storage with it. */
    discardUpload: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => discardUpload(ctx.account, input.id))),

    /** The file arrives as its rows, a batch at a time, from a caller that already
     *  holds them: a script, or a verify suite. The app uploads the file instead. */
    begin: protectedProcedure
      .input(
        z.object({
          // An object's key, or one of the five shape files the picker also offers.
          what: z.string().min(1).max(64),
          source: z.string().max(40).nullable(),
          filename: z.string().trim().min(1).max(255),
          headers: z.array(z.string()).min(1),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() => {
          const shape = (IMPORT_KINDS as readonly string[]).includes(input.what) && input.what !== 'records'
          return beginImportRun(ctx.account, {
            kind: shape ? (input.what as (typeof IMPORT_KINDS)[number]) : 'records',
            // A shape file is matched against contacts whatever it names.
            objectKey: shape ? 'contact' : input.what,
            source: input.source,
            filename: input.filename,
            headers: input.headers,
          })
        }),
      ),

    append: protectedProcedure
      .input(z.object({ id: z.uuid(), from: z.number().int().min(0), rows: z.array(z.array(z.string())).min(1) }))
      .mutation(({ ctx, input }) => call(() => appendImportRows(ctx.account, input.id, input))),

    finish: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => finishImportRun(ctx.account, input.id))),

    setMapping: protectedProcedure
      .input(
        z.object({
          id: z.uuid(),
          // A column goes into a field, into a property the run will make, or
          // nowhere. The third shape is what a migration spends most of its
          // mapping on: three hundred and seventy-two columns, most of them new.
          mapping: z.record(
            z.string(),
            z.union([
              z.string(),
              z.object({
                create: z.literal(true),
                key: z.string().trim().min(1).max(59),
                label: z.string().trim().min(1).max(120),
                type: z.enum(FIELD_TYPES),
                options: z.array(z.string().max(MAX_OPTION_LENGTH)).max(MAX_CHOICES).optional(),
              }),
              z.null(),
            ]),
          ),
        }),
      )
      .mutation(({ ctx, input }) => call(() => setImportMapping(ctx.account, input.id, input.mapping))),

    /** A mutation carrying an id, not a query carrying the file. As a GET it put
     *  up to 500 of somebody's rows in the URL, which is a request no browser
     *  sends and the reason preview answered "Failed to fetch". */
    dryRun: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => previewImportRun(ctx.account, input.id))),

    /** The run starts here and finishes in the worker, so closing the tab stops
     *  nothing. The page polls `read` for where it got to. */
    start: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => startImportRun(ctx.account, input.id))),

    /** Stopping for real. Without this, "Stop after this chunk" only stopped the
     *  tab asking, and the run sat at 'running' for ever. */
    cancel: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => cancelImportRun(ctx.account, input.id))),
  }),

  /** Used by the duplicate banner: given an id, what is it called. */
  nameOf: protectedProcedure
    .input(z.object({ object: anyObject, id: z.uuid() }))
    .query(({ ctx, input }) =>
      call(async () => {
        const record = await getRecord(ctx.account, input.object, input.id)
        return record?.displayName ?? null
      }),
    ),

  countsByObject: protectedProcedure.query(({ ctx }) =>
    call(() =>
      withAccount(ctx.account, async (tx) => {
        const rows = await tx.execute<{ object_key: string; n: number }>(sql`
          select 'contact' as object_key, count(*)::int as n from contact where deleted_at is null
          union all select 'company', count(*)::int from company where deleted_at is null
          union all select 'deal', count(*)::int from deal where deleted_at is null`)
        return Object.fromEntries(rows.map((row) => [row.object_key, Number(row.n)]))
      }),
    ),
  ),
})
