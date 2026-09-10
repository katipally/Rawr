import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { automation, automationRun } from '../schema/automation.ts'
import type { ObjectKey } from '../registry/core.ts'
import type { AccountContext } from './context.ts'
import { isUuid, mutate, withAccount } from './index.ts'
import { compileFilters, fieldExpression, parseFilters, scopeFor, type FilterGroup } from './query.ts'
import {
  fieldOrThrow,
  getRegistryIn,
  isObjectKey,
  objectOrThrow,
  rowsOf,
  tableFor,
  type RegistryObject,
} from './registry.ts'

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

export type AutomationTrigger =
  | 'record_created'
  | 'stage_changed'
  | 'lifecycle_changed'
  | 'form_submitted'
  /** A date field arrives, give or take a number of days. HubSpot's scheduled
   *  enrollment trigger, with its On date / Before date / After date. */
  | 'date_reached'
  /** Nothing has happened on the record for N days. */
  | 'no_activity'

export const AUTOMATION_TRIGGERS: AutomationTrigger[] = [
  'record_created',
  'stage_changed',
  'lifecycle_changed',
  'form_submitted',
  'date_reached',
  'no_activity',
]

/** The two nothing announces. They are found by an hourly scan, and a run they
 *  open carries the day it fired so the next scan in the same day finds it. */
export const SCANNED_TRIGGERS: AutomationTrigger[] = ['date_reached', 'no_activity']

export type ActionType =
  | 'set_field'
  | 'set_lifecycle'
  | 'assign_owner'
  | 'create_task'
  | 'notify_slack'
  | 'send_email'
  | 'enroll_in_sequence'
  | 'webhook'

export const ACTION_TYPES: ActionType[] = [
  'set_field',
  'set_lifecycle',
  'assign_owner',
  'create_task',
  'notify_slack',
  'send_email',
  'enroll_in_sequence',
  'webhook',
]

/** The three that write to a person rather than to a record. Only a contact has
 *  an inbox, so a rule watching a company or a deal is refused at save with the
 *  action named rather than failing on the first record that matches it. */
export const CONTACT_ONLY_ACTIONS: ActionType[] = ['send_email', 'enroll_in_sequence']

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
 *  A guard stops the rule; a branch takes one of two roads and carries on, which
 *  is HubSpot's if/then. "Wait three days, and if they have not replied, make a
 *  task" is a delay then a guard. "If they opened it, enrol them; otherwise post
 *  to Slack" is a branch. Both arms are lists of the same steps, so a branch can
 *  hold a delay or another branch, and the run remembers which arm it took. */
export type AutomationStep =
  | ({ kind: 'action' } & AutomationAction)
  | { kind: 'delay'; minutes: number }
  | { kind: 'guard'; conditions: FilterGroup[] }
  | { kind: 'branch'; conditions: FilterGroup[]; matched: AutomationStep[]; otherwise: AutomationStep[] }

/** Where a run is, once the steps are a tree.
 *
 *  `[2]` is the third step of the rule. `[2, 'otherwise', 1]` is the second step
 *  of that step's other road. A guard stops at its own path, a delay parks at the
 *  next one, and a path whose last number is past the end of its list means the
 *  arm finished and the level above continues. */
export type StepPath = (number | 'matched' | 'otherwise')[]

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
  /** Any object with a date field, including one an admin invented. */
  date_reached: null,
  /** The three that have a timeline. An activity hangs on a contact, a company or
   *  a deal and on nothing else, so "nothing has happened" is unanswerable for
   *  anything else. */
  no_activity: ['contact', 'company', 'deal'],
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
/** How deep a branch may sit inside a branch. Three is past the point a rule is
 *  readable and well short of anything the walker's recursion would notice. */
export const MAX_BRANCH_DEPTH = 3

export const parseSteps = (input: unknown, depth = 0): AutomationStep[] =>
  Array.isArray(input)
    ? input.flatMap((entry): AutomationStep[] => {
        const step = entry as {
          kind?: string
          type?: string
          config?: unknown
          minutes?: unknown
          conditions?: unknown
          matched?: unknown
          otherwise?: unknown
        }
        if (step.kind === 'delay') {
          const minutes = Math.floor(Number(step.minutes))
          return Number.isFinite(minutes) && minutes > 0
            ? [{ kind: 'delay', minutes: Math.min(minutes, MAX_DELAY_MINUTES) }]
            : []
        }
        if (step.kind === 'guard') return [{ kind: 'guard', conditions: parseFilters(step.conditions) }]
        if (step.kind === 'branch') {
          // Past the depth the editor offers, both arms are dropped and the
          // branch with them, rather than a rule that silently runs half of it.
          if (depth >= MAX_BRANCH_DEPTH) return []
          return [{
            kind: 'branch',
            conditions: parseFilters(step.conditions),
            matched: parseSteps(step.matched, depth + 1),
            otherwise: parseSteps(step.otherwise, depth + 1),
          }]
        }
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
  steps: parseSteps(row.steps),
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

/** Every step in the rule, arms included. Order is the reader's order, which is
 *  what makes an error message about "the third step" mean the third one down
 *  the page. */
const flatten = (steps: AutomationStep[]): AutomationStep[] =>
  steps.flatMap((step) =>
    step.kind === 'branch' ? [step, ...flatten(step.matched), ...flatten(step.otherwise)] : [step],
  )

const configText = (config: Record<string, unknown>, key: string): string => {
  const value = config[key]
  return typeof value === 'string' ? value.trim() : ''
}

const configInt = (config: Record<string, unknown>, key: string): number => {
  const value = Math.floor(Number(config[key]))
  return Number.isFinite(value) ? value : Number.NaN
}

/** How far either side of a date a rule may fire, and how long a record may be
 *  quiet before one notices. A year in both cases: past that the person who wrote
 *  the rule has forgotten it exists. */
export const MAX_TRIGGER_DAYS = 365

/** Refused at save, with the field named, rather than on the first record that
 *  matches. A scanned trigger is the case that matters: nobody is watching an
 *  hourly job, so a rule that can never match has to be caught here. */
const assertTriggerUsable = (
  object: RegistryObject,
  trigger: AutomationTrigger,
  config: Record<string, unknown>,
): void => {
  if (trigger === 'date_reached') {
    const field = fieldOrThrow(object, configText(config, 'fieldKey'))
    if (field.type !== 'date' && field.type !== 'datetime') {
      throw new Error(`${field.label} is not a date, so nothing about it can arrive.`)
    }
    const days = configInt(config, 'offsetDays')
    if (!Number.isFinite(days) || days < 0 || days > MAX_TRIGGER_DAYS) {
      throw new Error(`Say how many days either side of ${field.label}, from 0 to ${MAX_TRIGGER_DAYS}.`)
    }
    if (configText(config, 'direction') !== 'before' && configText(config, 'direction') !== 'after') {
      throw new Error('A date rule fires before or after the date. Pick one.')
    }
    return
  }

  if (trigger === 'no_activity') {
    const days = configInt(config, 'days')
    if (!Number.isFinite(days) || days < 1 || days > MAX_TRIGGER_DAYS) {
      throw new Error(`Say how many days of silence count, from 1 to ${MAX_TRIGGER_DAYS}.`)
    }
  }
}

const assertActionUsable = (
  step: { type: ActionType; config: Record<string, unknown> },
  objectKey: string,
): void => {
  if (CONTACT_ONLY_ACTIONS.includes(step.type) && objectKey !== 'contact') {
    throw new Error(`Only a contact can be written to, and this rule watches a ${objectKey}.`)
  }
  if (step.type === 'send_email' && !configText(step.config, 'templateId')) {
    throw new Error('That email step names no template.')
  }
  if (step.type === 'send_email' && !configText(step.config, 'mailboxId')) {
    throw new Error('That email step names no mailbox to send from.')
  }
  if (step.type === 'enroll_in_sequence' && !configText(step.config, 'sequenceId')) {
    throw new Error('That step names no sequence.')
  }
  if (step.type === 'enroll_in_sequence' && !configText(step.config, 'mailboxId')) {
    throw new Error('A sequence sends from somebody\u2019s mailbox. Say whose.')
  }
  if (step.type === 'webhook') {
    const url = configText(step.config, 'url')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`"${url}" is not an address anything can be sent to.`)
    }
    if (parsed.protocol !== 'https:') throw new Error('A webhook has to be https: the payload carries record data.')
    if (!configText(step.config, 'secret')) {
      throw new Error('A webhook needs a secret, or the receiver cannot tell the call came from Rawr.')
    }
  }
}

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
    const all = flatten(input.steps)
    if (all.every((step) => step.kind !== 'action')) {
      throw new Error('An automation that only waits and checks never does anything. Add an action.')
    }
    for (const step of all) {
      if (step.kind === 'action') assertActionUsable(step, input.objectKey)
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
    for (const step of all) {
      if (step.kind !== 'action' && step.kind !== 'delay') {
        compileFilters(object, step.conditions, scopeFor(null))
      }
    }
    assertTriggerUsable(object, input.trigger, input.triggerConfig ?? {})

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
  /** What the record is called, for a log a person reads. Null once the record
   *  has been deleted, which is ordinary: the run outlives it. */
  entityName: string | null
  state: AutomationRunState
  detail: string | null
  /** What each finished step did, in order. */
  trail: string[]
  /** Which step it is parked before, and when it wakes. Null on a finished run. */
  stepPath: StepPath
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
        stepPath: [],
      })
      .returning({ id: automationRun.id })
    if (!row) throw new Error('The automation run could not be opened.')
    return row.id
  })

/** The same, for a rule the scan found rather than an event announced.
 *
 *  Null means this rule already fired for this record today and the scan moves
 *  on. Separate from the one above because that answer only makes sense for a
 *  scanned run: an event happening twice in an afternoon is two firings, and a
 *  null there would be a rule quietly not running. */
export const openScannedRun = async (
  ctx: AccountContext,
  input: { automationId: string; entityType: string; entityId: string; scanDay: string },
): Promise<string | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx
      .insert(automationRun)
      .values({
        accountId: ctx.accountId,
        automationId: input.automationId,
        entityType: input.entityType,
        entityId: input.entityId,
        state: 'waiting',
        stepPath: [],
        scanDay: input.scanDay,
      })
      .onConflictDoNothing()
      .returning({ id: automationRun.id })
    return row?.id ?? null
  })

/** Parks a run at a step, to be picked up by the dispatcher. */
export const parkAutomationRun = async (
  ctx: AccountContext,
  runId: string,
  input: { stepPath: StepPath; resumeAt: Date; trail: string[] },
): Promise<void> => {
  await withAccount(ctx, (tx) =>
    tx
      .update(automationRun)
      .set({
        state: 'waiting',
        stepPath: input.stepPath,
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
  input: { state: Exclude<AutomationRunState, 'waiting'>; stepPath: StepPath; trail: string[]; detail?: string | null },
): Promise<void> => {
  await withAccount(ctx, (tx) =>
    tx
      .update(automationRun)
      .set({
        state: input.state,
        stepPath: input.stepPath,
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
): Promise<{ automationId: string; entityType: string; entityId: string; stepPath: StepPath; trail: string[] } | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{
      automation_id: string
      entity_type: string
      entity_id: string
      step_path: unknown
      trail: unknown
    }>(sql`
      update automation_run
         set lease_until = now() + ${`${leaseMinutes} minutes`}::interval
       where id = ${runId}::uuid
         and state = 'waiting'
         and resume_at is not null
         and resume_at <= now()
         and (lease_until is null or lease_until < now())
      returning automation_id, entity_type, entity_id, step_path, trail`)
    if (!row) return null
    return {
      automationId: String(row.automation_id),
      entityType: row.entity_type,
      entityId: String(row.entity_id),
      stepPath: asStepPath(row.step_path),
      trail: Array.isArray(row.trail) ? (row.trail as string[]) : [],
    }
  })

/** Anything unrecognised reads as the start of the rule. A run whose path was
 *  hand-edited or written by a newer version replays from the top rather than
 *  jamming the dispatcher forever. */
const asStepPath = (input: unknown): StepPath =>
  Array.isArray(input)
    ? input.flatMap((part): StepPath =>
        typeof part === 'number' && Number.isInteger(part) && part >= 0
          ? [part]
          : part === 'matched' || part === 'otherwise'
            ? [part]
            : [],
      )
    : []


/** How many runs one page of the log holds. The page pages what it is given, so
 *  this is the bound on how far back the reader can walk in one request, not on
 *  how many rows exist. */
export const RUN_PAGE = 200

export type RunFilter = {
  automationId?: string | undefined
  state?: AutomationRunState | undefined
  limit?: number | undefined
  offset?: number | undefined
}

export const listAutomationRuns = async (
  ctx: AccountContext,
  filter: RunFilter = {},
): Promise<AutomationRunRow[]> =>
  withAccount(ctx, async (tx) => {
    const limit = Math.min(Math.max(1, filter.limit ?? RUN_PAGE), RUN_PAGE)
    const offset = Math.max(0, filter.offset ?? 0)
    const where = [
      filter.automationId ? sql`r.automation_id = ${filter.automationId}::uuid` : null,
      filter.state ? sql`r.state = ${filter.state}` : null,
    ].filter((clause): clause is Exclude<typeof clause, null> => clause !== null)

    const rows = await tx.execute<{
      id: string
      automationId: string
      automation_name: string
      entityType: string
      entityId: string
      entity_name: string | null
      state: AutomationRunState
      detail: string | null
      trail: unknown
      step_path: unknown
      resume_at: unknown
      at: unknown
    }>(sql`
      select r.id, r.automation_id as "automationId", a.name as automation_name,
             r.entity_type as "entityType", r.entity_id as "entityId",
             -- The core three only. A custom object names its records by a field
             -- an admin picked, which is not a rule SQL here can know; the page
             -- falls back to the object's own name for those.
             case r.entity_type
               when 'contact' then (select coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email)
                                      from contact c where c.id = r.entity_id)
               when 'company' then (select coalesce(nullif(trim(co.name), ''), co.domain) from company co where co.id = r.entity_id)
               when 'deal' then (select d.name from deal d where d.id = r.entity_id)
             end as entity_name,
             r.state, r.detail, r.trail, r.step_path, r.resume_at, r.at
        from automation_run r join automation a on a.id = r.automation_id
       ${where.length > 0 ? sql`where ${sql.join(where, sql` and `)}` : sql``}
       -- Runs still waiting first, whatever their age: what a rule is about to do
       -- is more use than what it did last week, and a run parked three days ago
       -- would otherwise sink below a hundred finished ones.
       order by (r.resume_at is not null) desc, coalesce(r.resume_at, r.at) desc
       limit ${limit} offset ${offset}`)

    const when = (value: unknown): Date | null =>
      value == null ? null : value instanceof Date ? value : new Date(String(value))
    return rows.map((row) => ({
      id: String(row.id),
      automationId: String(row.automationId),
      automationName: String(row.automation_name),
      entityType: String(row.entityType),
      entityId: String(row.entityId),
      entityName: row.entity_name?.trim() || null,
      state: row.state,
      detail: row.detail,
      trail: Array.isArray(row.trail) ? (row.trail as string[]).map(String) : [],
      stepPath: asStepPath(row.step_path),
      resumeAt: when(row.resume_at),
      at: when(row.at) ?? new Date(),
    }))
  })

/** How many records one rule may fire on in one scan tick. The scan runs hourly,
 *  so a rule matching more than this catches up over the following hours rather
 *  than opening ten thousand runs at once. */
export const SCAN_LIMIT = 200

/** Every active rule whose trigger nothing announces. One query for the whole
 *  account, because the scan asks once an hour and there are never many. */
export const armedScans = async (ctx: AccountContext): Promise<AutomationRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx
      .select(SELECT)
      .from(automation)
      .where(and(eq(automation.isActive, true), inArray(automation.trigger, SCANNED_TRIGGERS)))
    return rows.map(shape)
  })

/** Which records a scanned rule matches today.
 *
 *  One scan of the object's rows per rule per tick, which is a sequential scan:
 *  both predicates are computed rather than stored, so no index answers them.
 *  Hourly, over one object, bounded by SCAN_LIMIT, and only for rules that are
 *  actually switched on.
 *
 *  `date_reached` matches the day the date lands, offset either way, so a rule
 *  fires exactly once for a given date. `no_activity` matches the day the record
 *  crosses into silence rather than every day it stays quiet: without that a
 *  thirty-day rule would make a task every morning forever. A record that has
 *  never had an activity is measured from when it was created. */
export const scanTargets = async (
  ctx: AccountContext,
  rule: AutomationRow,
  day: string,
): Promise<string[]> =>
  withAccount(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, rule.objectKey)
    const alias = sql.raw(`"${object.key}"`)

    let match: SQL
    if (rule.trigger === 'date_reached') {
      const field = fieldOrThrow(object, configText(rule.triggerConfig, 'fieldKey'))
      const days = Math.max(0, Math.min(configInt(rule.triggerConfig, 'offsetDays') || 0, MAX_TRIGGER_DAYS))
      // "three days before the close date" fires on the day three days earlier
      // than the date, which is the day the date is three days ahead of today.
      const target = configText(rule.triggerConfig, 'direction') === 'before'
        ? sql`${day}::date + ${days}::int`
        : sql`${day}::date - ${days}::int`
      match = sql`(${fieldExpression(object, field)})::date = ${target}`
    } else {
      if (!isObjectKey(object.key)) return []
      const days = Math.max(1, Math.min(configInt(rule.triggerConfig, 'days') || 1, MAX_TRIGGER_DAYS))
      const last = sql`coalesce(
        (select max(l.occurred_at) from activity_link l
          where l.entity_type = ${object.key} and l.entity_id = ${alias}.id),
        ${alias}.created_at)`
      match = sql`${last} < ${day}::date - ${days - 1}::int and ${last} >= ${day}::date - ${days}::int`
    }

    const rows = await tx.execute<{ id: string }>(sql`
      select ${alias}.id from ${tableFor(object)}
       where ${alias}.deleted_at is null and ${rowsOf(object)} and ${match}
       order by ${alias}.created_at
       limit ${SCAN_LIMIT}`)
    return rows.map((row) => String(row.id))
  })

/** One template, for the step that sends it. Read by id rather than found in the
 *  list, because the list stops at two hundred and a rule may name the two
 *  hundred and first. */
export const automationEmailTemplate = async (
  ctx: AccountContext,
  id: string,
): Promise<{ subject: string; bodyText: string } | null> =>
  withAccount(ctx, async (tx) => {
    if (!isUuid(id)) return null
    const [row] = await tx.execute<{ subject: string; body_text: string }>(
      sql`select subject, body_text from email_template where id = ${id}::uuid limit 1`,
    )
    return row ? { subject: String(row.subject), bodyText: String(row.body_text) } : null
  })
