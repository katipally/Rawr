import { and, desc, eq, sql } from 'drizzle-orm'
import { automation, automationRun } from '../schema/automation.ts'
import type { ObjectKey } from '../registry/core.ts'
import type { AccountContext } from './context.ts'
import { assertCanWrite } from './context.ts'
import { mutate, withAccount } from './index.ts'
import { compileFilters, parseFilters, scopeFor, type FilterGroup } from './query.ts'
import { getRegistryIn, objectOrThrow, rowsOf, tableFor } from './registry.ts'

/** B11. When this happens, do that.
 *
 *  The read and write side of the rules; the running of them lives in the web
 *  app, next to the Slack queue and the same `inBackground` the stage alert
 *  already uses, because that is where the writes that trigger them are already
 *  reported. This file decides which rules are armed for an event and whether
 *  their conditions hold, and it does the second one in SQL against the record
 *  itself rather than in TypeScript against a copy: a segment and an automation
 *  ask the same question, and two filter languages in one product is one too
 *  many. */

export type AutomationTrigger = 'record_created' | 'stage_changed' | 'lifecycle_changed' | 'form_submitted'

export const AUTOMATION_TRIGGERS: AutomationTrigger[] = [
  'record_created',
  'stage_changed',
  'lifecycle_changed',
  'form_submitted',
]

export type ActionType =
  | 'set_field'
  | 'set_lifecycle'
  | 'assign_owner'
  | 'create_task'
  | 'notify_slack'

export const ACTION_TYPES: ActionType[] = [
  'set_field',
  'set_lifecycle',
  'assign_owner',
  'create_task',
  'notify_slack',
]

export type AutomationAction = { type: ActionType; config: Record<string, unknown> }

/** One step of a rule.
 *
 *  A rule used to be a list of actions run inside the request that triggered it,
 *  which cannot say "wait, then look again". Three kinds cover what teams ask
 *  for, and they compose in a straight line:
 *
 *    action  do one of the five things
 *    delay   park the run and come back to it later
 *    guard   re-read the record now and stop unless it still matches
 *
 *  A guard is how a branch is written here. "Wait three days, and if they have
 *  not replied, make a task" is a delay then a guard then an action, and it is a
 *  list a person can read down. Two arms would need a graph, an editor for the
 *  graph, and a way to resume into either arm; a second arm is a second rule. */
export type AutomationStep =
  | ({ kind: 'action' } & AutomationAction)
  | { kind: 'delay'; minutes: number }
  | { kind: 'guard'; conditions: FilterGroup[] }

/** A day is the unit people reach for, but a delay measured in minutes lets
 *  "twenty minutes after the form" exist too. Capped at a year: a rule that fires
 *  after longer than that is a rule nobody will remember writing. */
export const MAX_DELAY_MINUTES = 366 * 24 * 60

export type AutomationRow = {
  id: string
  name: string
  isActive: boolean
  trigger: AutomationTrigger
  /** Which object this watches. Every trigger names one, because a condition is
   *  compiled against that object's fields and there is no such thing as a
   *  filter that spans two. */
  objectKey: string
  triggerConfig: Record<string, unknown>
  conditions: FilterGroup[]
  steps: AutomationStep[]
  /** Denormalised for the list: how many times it has fired, and when last. */
  runCount: number
  lastRunAt: Date | null
  createdAt: Date
}

/** Which object a trigger can watch. `stage_changed` is deals only because only a
 *  deal has a pipeline; `form_submitted` is contacts only because a form fill
 *  produces a person. `record_created` is null for "any object in this account",
 *  which is the only honest answer once an admin can invent one. */
export const OBJECTS_FOR_TRIGGER: Record<AutomationTrigger, ObjectKey[] | null> = {
  record_created: null,
  stage_changed: ['deal'],
  lifecycle_changed: ['contact', 'company'],
  form_submitted: ['contact'],
}

const objectOf = (row: { triggerConfig: unknown; trigger: string }): string => {
  const configured = (row.triggerConfig as { object?: string } | null)?.object
  const allowed = OBJECTS_FOR_TRIGGER[row.trigger as AutomationTrigger]
  if (allowed === null || allowed === undefined) return configured ?? 'contact'
  return allowed.includes(configured as ObjectKey) ? (configured as string) : allowed[0]!
}

/** Anything unrecognised is dropped rather than throwing: a rule saved by a newer
 *  version, or one hand-edited in the database, should run the steps it can and
 *  not take the screen down. */
const asSteps = (input: unknown): AutomationStep[] =>
  Array.isArray(input)
    ? input.flatMap((entry): AutomationStep[] => {
        const step = entry as { kind?: string; type?: string; config?: unknown; minutes?: unknown; conditions?: unknown }
        if (step.kind === 'delay') {
          const minutes = Math.floor(Number(step.minutes))
          return Number.isFinite(minutes) && minutes > 0
            ? [{ kind: 'delay', minutes: Math.min(minutes, MAX_DELAY_MINUTES) }]
            : []
        }
        if (step.kind === 'guard') return [{ kind: 'guard', conditions: parseFilters(step.conditions) }]
        // No kind at all is an action: that is the shape every rule had before
        // steps existed, and one may still be sitting in a column somewhere.
        if (!ACTION_TYPES.includes(step.type as ActionType)) return []
        return [{
          kind: 'action',
          type: step.type as ActionType,
          config: (step.config ?? {}) as Record<string, unknown>,
        }]
      })
    : []

const SELECT = {
  id: automation.id,
  name: automation.name,
  isActive: automation.isActive,
  trigger: automation.trigger,
  triggerConfig: automation.triggerConfig,
  conditions: automation.conditions,
  steps: automation.steps,
  createdAt: automation.createdAt,
}

const shape = (row: Record<string, unknown>): AutomationRow => ({
  id: String(row.id),
  name: String(row.name),
  isActive: row.isActive === true,
  trigger: row.trigger as AutomationTrigger,
  objectKey: objectOf(row as { triggerConfig: unknown; trigger: string }),
  triggerConfig: (row.triggerConfig ?? {}) as Record<string, unknown>,
  conditions: parseFilters(row.conditions),
  steps: asSteps(row.steps),
  runCount: Number(row.runCount ?? 0),
  lastRunAt: row.lastRunAt ? new Date(String(row.lastRunAt)) : null,
  createdAt: new Date(String(row.createdAt)),
})

export const listAutomations = async (ctx: AccountContext): Promise<AutomationRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.select(SELECT).from(automation).orderBy(desc(automation.createdAt))
    // One grouped read for every rule's counters rather than one per rule.
    const counts = await tx.execute<{ automation_id: string; n: number; last_at: Date }>(
      sql`select automation_id, count(*)::int as n, max(at) as last_at
            from automation_run group by automation_id`,
    )
    const byId = new Map(counts.map((row) => [row.automation_id, row]))
    return rows.map((row) =>
      shape({ ...row, runCount: byId.get(row.id)?.n ?? 0, lastRunAt: byId.get(row.id)?.last_at ?? null }),
    )
  })

export const readAutomation = async (ctx: AccountContext, id: string): Promise<AutomationRow | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.select(SELECT).from(automation).where(eq(automation.id, id)).limit(1)
    return row ? shape(row) : null
  })

export type SaveAutomationInput = {
  id?: string | null
  name: string
  trigger: AutomationTrigger
  objectKey: string
  triggerConfig?: Record<string, unknown>
  conditions: FilterGroup[]
  steps: AutomationStep[]
  isActive?: boolean
}

export const saveAutomation = async (
  ctx: AccountContext,
  input: SaveAutomationInput,
): Promise<{ id: string }> =>
  mutate(ctx, 'automation', async (tx) => {
    const name = input.name.trim()
    if (!name) throw new Error('An automation needs a name.')
    if (!AUTOMATION_TRIGGERS.includes(input.trigger)) throw new Error('That is not a trigger.')
    const allowed = OBJECTS_FOR_TRIGGER[input.trigger]
    if (allowed !== null && !allowed.includes(input.objectKey as ObjectKey)) {
      throw new Error(`${input.trigger.replace('_', ' ')} does not happen to a ${input.objectKey}.`)
    }
    if (input.steps.length === 0) {
      throw new Error('An automation with no steps would watch for something and then do nothing.')
    }
    if (input.steps.every((step) => step.kind !== 'action')) {
      throw new Error('An automation that only waits and checks never does anything. Add an action.')
    }

    // Refused at save with the field and operator named, rather than failing on
    // the first record that triggers it, where nobody is looking.
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, input.objectKey)
    // Scoped to nobody: a condition saying "owned by me" would mean the person who
    // saved the rule, forever, which is never what somebody writing an automation
    // means. `scopeFor(null)` resolves those tokens to nothing and the save is
    // refused with the field named.
    compileFilters(object, input.conditions, scopeFor(null))
    // A guard is the same filter language against the same object, so it is
    // checked the same way and at the same moment: a rule with an unusable guard
    // is refused here rather than three days later, parked mid-run, where the
    // person who wrote it is no longer looking.
    for (const step of input.steps) {
      if (step.kind === 'guard') compileFilters(object, step.conditions, scopeFor(null))
    }

    const values = {
      name,
      trigger: input.trigger,
      triggerConfig: { ...(input.triggerConfig ?? {}), object: input.objectKey },
      conditions: input.conditions,
      steps: input.steps,
      isActive: input.isActive ?? false,
      updatedAt: new Date(),
    }

    if (input.id) {
      const [before] = await tx.select(SELECT).from(automation).where(eq(automation.id, input.id)).limit(1)
      if (!before) throw new Error('That automation no longer exists.')
      await tx.update(automation).set(values).where(eq(automation.id, input.id))
      return {
        result: { id: input.id },
        audit: { entity: 'automation', entityId: input.id, action: 'update', before, after: values },
      }
    }

    const [created] = await tx
      .insert(automation)
      .values({ accountId: ctx.accountId, createdBy: ctx.actorId, ...values })
      .returning({ id: automation.id })
    if (!created) throw new Error('The automation could not be created.')
    return {
      result: { id: created.id },
      audit: { entity: 'automation', entityId: created.id, action: 'create', before: null, after: values },
    }
  })

export const setAutomationActive = async (
  ctx: AccountContext,
  id: string,
  isActive: boolean,
): Promise<void> =>
  mutate(ctx, 'automation', async (tx) => {
    const [before] = await tx
      .select({ isActive: automation.isActive, name: automation.name })
      .from(automation)
      .where(eq(automation.id, id))
      .limit(1)
    if (!before) throw new Error('That automation no longer exists.')
    await tx.update(automation).set({ isActive, updatedAt: new Date() }).where(eq(automation.id, id))
    return {
      result: undefined,
      audit: { entity: 'automation', entityId: id, action: isActive ? 'enable' : 'disable', before, after: { isActive } },
    }
  })

export const removeAutomation = async (ctx: AccountContext, id: string): Promise<void> =>
  mutate(ctx, 'automation', async (tx) => {
    const [before] = await tx.select(SELECT).from(automation).where(eq(automation.id, id)).limit(1)
    if (!before) throw new Error('That automation no longer exists.')
    await tx.delete(automation).where(eq(automation.id, id))
    return {
      result: undefined,
      audit: { entity: 'automation', entityId: id, action: 'delete', before, after: null },
    }
  })

/** Every active rule armed for this event. The one query the runner makes. */
export const armedFor = async (
  ctx: AccountContext,
  trigger: AutomationTrigger,
  objectKey: string,
): Promise<AutomationRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx
      .select(SELECT)
      .from(automation)
      .where(and(eq(automation.trigger, trigger), eq(automation.isActive, true)))
    return rows.map(shape).filter((row) => row.objectKey === objectKey)
  })

/** Whether the record that triggered this still matches the rule's conditions.
 *
 *  Asked of the database rather than of a copy of the record the caller happens
 *  to hold: an action earlier in the same run may already have changed it, and a
 *  condition judged against a stale copy is a condition that lies. */
export const conditionsHold = async (
  ctx: AccountContext,
  objectKey: string,
  entityId: string,
  conditions: FilterGroup[],
): Promise<boolean> => {
  if (conditions.length === 0 || conditions.every((group) => group.conditions.length === 0)) return true
  return withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, objectKey)
    const where = compileFilters(object, conditions, scopeFor(null))
    const [row] = await tx.execute<{ hit: number }>(sql`
      select 1 as hit from ${tableFor(object)}
       where ${sql.raw(`"${objectKey}"."id"`)} = ${entityId}::uuid
         and ${sql.raw(`"${objectKey}"."deleted_at"`)} is null
         and ${rowsOf(object)}
         ${where ? sql`and ${where}` : sql``}
       limit 1`)
    return Boolean(row)
  })
}

/** The slug this account lives under, for the link an action puts in Slack.
 *
 *  Everywhere else it arrives from the session or the public page's own URL. A
 *  resumed run has neither: it is picked up by the worker days after whoever
 *  triggered it went home. Row level security makes the `limit 1` exact, because
 *  a scoped transaction can see exactly one account row. */
export const accountSlugFor = async (ctx: AccountContext): Promise<string> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{ slug: string }>(sql`select slug from account limit 1`)
    if (!row) throw new Error('That account no longer exists.')
    return String(row.slug)
  })

export type AutomationRunState = 'waiting' | 'done' | 'skipped' | 'failed'

export type AutomationRunRow = {
  id: string
  automationId: string
  automationName: string
  entityType: string
  entityId: string
  state: AutomationRunState
  detail: string | null
  /** Which step it is parked before, and when it wakes. Null on a finished run. */
  stepIndex: number
  resumeAt: Date | null
  at: Date
}

/** Opens the run. One row per firing, written before the first step so that a
 *  process dying mid-run leaves evidence rather than silence. */
export const openAutomationRun = async (
  ctx: AccountContext,
  input: { automationId: string; entityType: string; entityId: string },
): Promise<string> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx
      .insert(automationRun)
      .values({
        accountId: ctx.accountId,
        automationId: input.automationId,
        entityType: input.entityType,
        entityId: input.entityId,
        state: 'waiting',
        stepIndex: 0,
      })
      .returning({ id: automationRun.id })
    if (!row) throw new Error('The automation run could not be opened.')
    return row.id
  })

/** Parks a run at a step, to be picked up by the dispatcher. */
export const parkAutomationRun = async (
  ctx: AccountContext,
  runId: string,
  input: { stepIndex: number; resumeAt: Date; trail: string[] },
): Promise<void> => {
  await withAccount(ctx, (tx) =>
    tx
      .update(automationRun)
      .set({
        state: 'waiting',
        stepIndex: input.stepIndex,
        resumeAt: input.resumeAt,
        leaseUntil: null,
        trail: input.trail,
      })
      .where(eq(automationRun.id, runId)),
  )
}

/** Closes the run. `resumeAt` is cleared, which is what takes it out of the
 *  dispatcher's partial index: a finished run costs the queue nothing. */
export const finishAutomationRun = async (
  ctx: AccountContext,
  runId: string,
  input: { state: Exclude<AutomationRunState, 'waiting'>; stepIndex: number; trail: string[]; detail?: string | null },
): Promise<void> => {
  await withAccount(ctx, (tx) =>
    tx
      .update(automationRun)
      .set({
        state: input.state,
        stepIndex: input.stepIndex,
        resumeAt: null,
        leaseUntil: null,
        trail: input.trail,
        detail: (input.detail ?? input.trail.join(', ')).slice(0, 1000) || null,
      })
      .where(eq(automationRun.id, runId)),
  )
}

/** Takes a due run, if nobody else has it. The lease is what stops two workers
 *  advancing the same run, and it is checked and set in one statement so there is
 *  no window between the two.
 *
 *  There is deliberately no sweep alongside this, unlike sequences. A lease a
 *  dead process left behind simply expires, and the next dispatch tick claims the
 *  run because that is the same condition this statement already tests. A sweep
 *  would be a second job to say what `lease_until < now()` says here. */
export const claimAutomationRun = async (
  ctx: AccountContext,
  runId: string,
  leaseMinutes = 5,
): Promise<{ automationId: string; entityType: string; entityId: string; stepIndex: number; trail: string[] } | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{
      automation_id: string
      entity_type: string
      entity_id: string
      step_index: number
      trail: unknown
    }>(sql`
      update automation_run
         set lease_until = now() + ${`${leaseMinutes} minutes`}::interval
       where id = ${runId}::uuid
         and state = 'waiting'
         and resume_at is not null
         and resume_at <= now()
         and (lease_until is null or lease_until < now())
      returning automation_id, entity_type, entity_id, step_index, trail`)
    if (!row) return null
    return {
      automationId: String(row.automation_id),
      entityType: row.entity_type,
      entityId: String(row.entity_id),
      stepIndex: Number(row.step_index),
      trail: Array.isArray(row.trail) ? (row.trail as string[]) : [],
    }
  })


export const listAutomationRuns = async (
  ctx: AccountContext,
  filter: { automationId?: string } = {},
): Promise<AutomationRunRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<
      Omit<AutomationRunRow, 'stepIndex' | 'resumeAt' | 'at'> & {
        automation_name: string
        step_index: number
        resume_at: unknown
        at: unknown
      }
    >(sql`
      select r.id, r.automation_id as "automationId", a.name as automation_name,
             r.entity_type as "entityType", r.entity_id as "entityId",
             r.state, r.detail, r.step_index, r.resume_at, r.at
        from automation_run r join automation a on a.id = r.automation_id
       ${filter.automationId ? sql`where r.automation_id = ${filter.automationId}::uuid` : sql``}
       -- Runs still waiting first, whatever their age: what a rule is about to do
       -- is more use than what it did last week, and a run parked three days ago
       -- would otherwise sink below a hundred finished ones.
       order by (r.resume_at is not null) desc, coalesce(r.resume_at, r.at) desc
       limit 200`)
    const when = (value: unknown): Date | null =>
      value == null ? null : value instanceof Date ? value : new Date(String(value))
    return rows.map((row) => ({
      id: String(row.id),
      automationId: String(row.automationId),
      automationName: String(row.automation_name),
      entityType: String(row.entityType),
      entityId: String(row.entityId),
      state: row.state,
      detail: row.detail,
      stepIndex: Number(row.step_index ?? 0),
      resumeAt: when(row.resume_at),
      at: when(row.at) ?? new Date(),
    }))
  })
