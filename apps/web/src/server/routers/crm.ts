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
  duplicateView,
  dissociate,
  dryRun,
  findDuplicates,
  getRecord,
  IMPORT_KINDS,
  getRegistry,
  isActivityType,
  listRecords,
  listTasks,
  listViews,
  mergeRecords,
  overdueNextSteps,
  readAssociations,
  renameView,
  reorderViews,
  setViewPinned,
  assertCanAttach,
  listAttachments,
  MAX_ATTACHMENT_BYTES,
  readAttachment,
  readBoard,
  recordAttachment,
  removeAttachment,
  storageKeyFor,
  readCalendar,
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
  type ObjectKey,
  type UpdateResult,
  type WorkspaceContext,
} from '@rawr/db'
import { reportEvent } from '../automations.ts'
import { propagateSubscriptionToBrevo } from '../integrations/brevo.ts'
import { asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { call } from '../errors.ts'
import { announceStageChange } from '../stage-alerts.ts'
import { NOT_CONFIGURED, removeObject, signedDownload, signedUpload, storageConfigured } from '../storage.ts'
import { protectedProcedure, router } from '../trpc.ts'

/** The three the system is built on. Used where a procedure genuinely needs one:
 *  a timeline entry, an association and a task all name an entity type that is an
 *  enum of exactly these, so widening it here would let a request in that the
 *  database cannot store. */
const objectKey = z.enum(['contact', 'company', 'deal'])

/** Any object in the workspace, including one an admin invented. The registry is
 *  what decides whether it exists — this only proves the string is shaped like a
 *  key, because it reaches SQL as an alias and appears in a URL. */
const anyObject = z.string().regex(/^[a-z][a-z0-9_]{1,58}$/, 'That is not an object.')
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

/** A stage move and a lifecycle move are two triggers on one write, so both are
 *  read off the same result rather than from two separate calls. `updateRecord`
 *  reports exactly one of them per write, because they are different columns. */
const fireChangeAutomations = (
  ctx: { workspace: WorkspaceContext; session: { workspaceSlug: string } },
  // Any object: a custom one has no stage or lifecycle, so `trigger` below is
  // null for it and this returns before reportEvent is reached at all.
  object: string,
  id: string,
  result: UpdateResult,
): void => {
  const trigger = result.stageChange ? 'stage_changed' : result.lifecycleChanged ? 'lifecycle_changed' : null
  if (!trigger) return
  reportEvent(ctx.workspace, {
    trigger,
    objectKey: object,
    entityId: id,
    displayName: result.displayName,
    workspaceSlug: ctx.session.workspaceSlug,
  })
}

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
      .input(z.object({ object: anyObject, id: z.uuid() }))
      .query(({ ctx, input }) => call(() => getRecord(ctx.workspace, input.object, input.id))),

    /** What every record picker reads. A capped, ranked answer to "which record
     *  did you mean", never the whole object. */
    /** The relation picker. Core objects only: what a record is called in a
     *  picker is a per-object expression, and a relation pointing at a custom
     *  object is a later change than this one. */
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
      .input(z.object({ object: anyObject, values: recordValues }))
      .mutation(({ ctx, input }) =>
        call(async () => {
          const result = await createRecord(ctx.workspace, input.object, input.values)
          reportEvent(ctx.workspace, {
            trigger: 'record_created',
            objectKey: input.object,
            entityId: result.id,
            displayName: result.displayName,
            workspaceSlug: ctx.session.workspaceSlug,
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
            ctx.workspace,
            input.object,
            input.id,
            input.values,
            input.expectedUpdatedAt ?? null,
          )
          announceStageChange(ctx.workspace, ctx.session.workspaceSlug, result.stageChange, ctx.session.displayName)
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
        call(() => bulkUpdateRecords(ctx.workspace, input.object, input.ids, input.values)),
      ),

    remove: protectedProcedure
      .input(z.object({ object: anyObject, id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteRecord(ctx.workspace, input.object, input.id))),

    /** The review queue behind the merge dialog. Read-only, gated on write: it
     *  lists two records side by side asserting they might be one person, which
     *  is not a thing to put in front of somebody who cannot act on it. */
    duplicates: protectedProcedure
      .input(z.object({ object: z.enum(['contact', 'company']), limit: z.number().int().min(1).max(200).optional() }))
      .query(({ ctx, input }) =>
        call(() => findDuplicates(ctx.workspace, input.object, input.limit ? { limit: input.limit } : {})),
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
      .input(z.object({ object: anyObject }))
      .query(({ ctx, input }) => call(() => listViews(ctx.workspace, input.object))),

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

    rename: protectedProcedure
      .input(z.object({ id: z.uuid(), name: z.string().trim().min(1).max(80) }))
      .mutation(({ ctx, input }) => call(() => renameView(ctx.workspace, input.id, input.name))),

    duplicate: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => duplicateView(ctx.workspace, input.id))),

    pin: protectedProcedure
      .input(z.object({ id: z.uuid(), pinned: z.boolean() }))
      .mutation(({ ctx, input }) => call(() => setViewPinned(ctx.workspace, input.id, input.pinned))),

    reorder: protectedProcedure
      .input(z.object({ object: objectKey, ids: z.array(z.uuid()).min(1).max(100) }))
      .mutation(({ ctx, input }) => call(() => reorderViews(ctx.workspace, input.object, input.ids))),

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
      .input(z.object({ entityType: objectKey, entityId: z.uuid() }))
      .query(({ ctx, input }) =>
        call(async () => ({
          configured: storageConfigured,
          rows: storageConfigured ? await listAttachments(ctx.workspace, input) : [],
        })),
      ),

    sign: protectedProcedure
      .input(
        z.object({
          entityType: objectKey,
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
          assertCanAttach(ctx.workspace, input.bytes)
          const storageKey = storageKeyFor(ctx.workspace, input)
          const { url } = await signedUpload(storageKey)
          return { storageKey, url }
        }),
      ),

    confirm: protectedProcedure
      .input(
        z.object({
          entityType: objectKey,
          entityId: z.uuid(),
          storageKey: z.string().min(1).max(500),
          filename: z.string().min(1).max(255),
          bytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
          mime: z.string().max(120),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(async () => {
          // The key is rebuilt from the workspace on the session, so a client
          // cannot confirm a row against a path in somebody else's prefix.
          if (!input.storageKey.startsWith(`${ctx.workspace.workspaceId}/`)) {
            throw new Error('That file does not belong to this workspace.')
          }
          return recordAttachment(ctx.workspace, input)
        }),
      ),

    /** A link that stops working, minted per click. The row is read first, which
     *  is what proves the key belongs to this workspace before one is issued. */
    link: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) =>
        call(async () => {
          const row = await readAttachment(ctx.workspace, input.id)
          if (!row) throw new Error('That file is gone.')
          return { url: await signedDownload(row.storageKey, 120, row.filename) }
        }),
      ),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) =>
        call(async () => {
          const { storageKey } = await removeAttachment(ctx.workspace, input.id)
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
          object: objectKey,
          /** Any day in the month wanted. The layer takes the month from it. */
          month: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, 'A month looks like 2026-09.'),
          field: z.string().min(1).max(64),
          filters: z.array(filterGroup).max(5).optional(),
          search: z.string().max(200).optional(),
        }),
      )
      .query(({ ctx, input }) =>
        call(() =>
          readCalendar(ctx.workspace, {
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
      .input(
        z.object({
          entity: entityRef,
          q: z.string().max(200).optional(),
          sort: z.enum(['recent', 'name']).optional(),
        }),
      )
      .query(({ ctx, input }) =>
        call(() => readAssociations(ctx.workspace, input.entity, { q: input.q, sort: input.sort })),
      ),

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
      .mutation(({ ctx, input }) =>
        call(async () => {
          await setSubscription(ctx.workspace, input)
          // After the write, never before: Brevo being down must not block a
          // person from recording an opt-out. A failure dead-letters and replays.
          await propagateSubscriptionToBrevo(ctx.workspace, input).catch(() => undefined)
        }),
      ),
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
          kind: z.enum(IMPORT_KINDS).default('records'),
          source: z.string().max(60).nullable().default(null),
          mapping: z.record(z.string(), z.string().nullable()),
          rows: z.array(z.record(z.string(), z.string())).max(5000),
        }),
      )
      .query(({ ctx, input }) =>
        call(() =>
          dryRun(ctx.workspace, {
            objectKey: input.object,
            kind: input.kind,
            source: input.source,
            mapping: input.mapping,
            rows: input.rows,
          }),
        ),
      ),

    /** One chunk per call. The page polls, so closing the tab does not stop it and
     *  reopening the page shows where it got to. */
    runChunk: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => runImportChunk(ctx.workspace, input.id))),
  }),

  /** Used by the duplicate banner: given an id, what is it called. */
  nameOf: protectedProcedure
    .input(z.object({ object: anyObject, id: z.uuid() }))
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
