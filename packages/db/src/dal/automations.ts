import { and, desc, eq, sql } from 'drizzle-orm'
import { automation, automationRun } from '../schema/automation.ts'
import type { ObjectKey } from '../registry/core.ts'
import type { WorkspaceContext } from './context.ts'
import { assertCanWrite } from './context.ts'
import { mutate, withWorkspace } from './index.ts'
import { compileFilters, parseFilters, scopeFor, type FilterGroup } from './query.ts'
import { getRegistryIn, objectOrThrow } from './registry.ts'

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

export type AutomationRow = {
  id: string
  name: string
  isActive: boolean
  trigger: AutomationTrigger
  /** Which object this watches. Every trigger names one, because a condition is
   *  compiled against that object's fields and there is no such thing as a
   *  filter that spans two. */
  objectKey: ObjectKey
  triggerConfig: Record<string, unknown>
  conditions: FilterGroup[]
  actions: AutomationAction[]
  /** Denormalised for the list: how many times it has fired, and when last. */
  runCount: number
  lastRunAt: Date | null
  createdAt: Date
}

/** Which object a trigger can watch. `stage_changed` is deals only because only a
 *  deal has a pipeline; `form_submitted` is contacts only because a form fill
 *  produces a person. */
export const OBJECTS_FOR_TRIGGER: Record<AutomationTrigger, ObjectKey[]> = {
  record_created: ['contact', 'company', 'deal'],
  stage_changed: ['deal'],
  lifecycle_changed: ['contact', 'company'],
  form_submitted: ['contact'],
}

const objectOf = (row: { triggerConfig: unknown; trigger: string }): ObjectKey => {
  const configured = (row.triggerConfig as { object?: string } | null)?.object
  const allowed = OBJECTS_FOR_TRIGGER[row.trigger as AutomationTrigger] ?? ['contact']
  return (allowed.includes(configured as ObjectKey) ? configured : allowed[0]) as ObjectKey
}

const asActions = (input: unknown): AutomationAction[] =>
  Array.isArray(input)
    ? input.flatMap((entry) => {
        const action = entry as { type?: string; config?: unknown }
        if (!ACTION_TYPES.includes(action.type as ActionType)) return []
        return [{ type: action.type as ActionType, config: (action.config ?? {}) as Record<string, unknown> }]
      })
    : []

const SELECT = {
  id: automation.id,
  name: automation.name,
  isActive: automation.isActive,
  trigger: automation.trigger,
  triggerConfig: automation.triggerConfig,
  conditions: automation.conditions,
  actions: automation.actions,
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
  actions: asActions(row.actions),
  runCount: Number(row.runCount ?? 0),
  lastRunAt: row.lastRunAt ? new Date(String(row.lastRunAt)) : null,
  createdAt: new Date(String(row.createdAt)),
})

export const listAutomations = async (ctx: WorkspaceContext): Promise<AutomationRow[]> =>
  withWorkspace(ctx, async (tx) => {
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

export const readAutomation = async (ctx: WorkspaceContext, id: string): Promise<AutomationRow | null> =>
  withWorkspace(ctx, async (tx) => {
    const [row] = await tx.select(SELECT).from(automation).where(eq(automation.id, id)).limit(1)
    return row ? shape(row) : null
  })

export type SaveAutomationInput = {
  id?: string | null
  name: string
  trigger: AutomationTrigger
  objectKey: ObjectKey
  triggerConfig?: Record<string, unknown>
  conditions: FilterGroup[]
  actions: AutomationAction[]
  isActive?: boolean
}

export const saveAutomation = async (
  ctx: WorkspaceContext,
  input: SaveAutomationInput,
): Promise<{ id: string }> =>
  mutate(ctx, 'automation', async (tx) => {
    const name = input.name.trim()
    if (!name) throw new Error('An automation needs a name.')
    if (!AUTOMATION_TRIGGERS.includes(input.trigger)) throw new Error('That is not a trigger.')
    if (!OBJECTS_FOR_TRIGGER[input.trigger].includes(input.objectKey)) {
      throw new Error(`${input.trigger.replace('_', ' ')} does not happen to a ${input.objectKey}.`)
    }
    if (input.actions.length === 0) {
      throw new Error('An automation with no actions would watch for something and then do nothing.')
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

    const values = {
      name,
      trigger: input.trigger,
      triggerConfig: { ...(input.triggerConfig ?? {}), object: input.objectKey },
      conditions: input.conditions,
      actions: input.actions,
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
      .values({ workspaceId: ctx.workspaceId, createdBy: ctx.actorId, ...values })
      .returning({ id: automation.id })
    if (!created) throw new Error('The automation could not be created.')
    return {
      result: { id: created.id },
      audit: { entity: 'automation', entityId: created.id, action: 'create', before: null, after: values },
    }
  })

export const setAutomationActive = async (
  ctx: WorkspaceContext,
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

export const removeAutomation = async (ctx: WorkspaceContext, id: string): Promise<void> =>
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
  ctx: WorkspaceContext,
  trigger: AutomationTrigger,
  objectKey: ObjectKey,
): Promise<AutomationRow[]> =>
  withWorkspace(ctx, async (tx) => {
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
  ctx: WorkspaceContext,
  objectKey: ObjectKey,
  entityId: string,
  conditions: FilterGroup[],
): Promise<boolean> => {
  if (conditions.length === 0 || conditions.every((group) => group.conditions.length === 0)) return true
  return withWorkspace(ctx, async (tx) => {
    const registry = await getRegistryIn(tx)
    const object = objectOrThrow(registry, objectKey)
    const where = compileFilters(object, conditions, scopeFor(null))
    const [row] = await tx.execute<{ hit: number }>(sql`
      select 1 as hit from ${sql.raw(`"${objectKey}"`)}
       where ${sql.raw(`"${objectKey}"."id"`)} = ${entityId}::uuid
         and ${sql.raw(`"${objectKey}"."deleted_at"`)} is null
         ${where ? sql`and ${where}` : sql``}
       limit 1`)
    return Boolean(row)
  })
}

export type AutomationRunRow = {
  id: string
  automationId: string
  automationName: string
  entityType: string
  entityId: string
  state: 'done' | 'skipped' | 'failed'
  detail: string | null
  at: Date
}

export const recordAutomationRun = async (
  ctx: WorkspaceContext,
  input: {
    automationId: string
    entityType: ObjectKey
    entityId: string
    state: 'done' | 'skipped' | 'failed'
    detail?: string | null
  },
): Promise<void> => {
  await withWorkspace(ctx, (tx) =>
    tx.insert(automationRun).values({
      workspaceId: ctx.workspaceId,
      automationId: input.automationId,
      entityType: input.entityType,
      entityId: input.entityId,
      state: input.state,
      detail: input.detail?.slice(0, 1000) ?? null,
    }),
  )
}

export const listAutomationRuns = async (
  ctx: WorkspaceContext,
  filter: { automationId?: string } = {},
): Promise<AutomationRunRow[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx.execute<AutomationRunRow & { automation_name: string }>(sql`
      select r.id, r.automation_id as "automationId", a.name as automation_name,
             r.entity_type as "entityType", r.entity_id as "entityId",
             r.state, r.detail, r.at
        from automation_run r join automation a on a.id = r.automation_id
       ${filter.automationId ? sql`where r.automation_id = ${filter.automationId}::uuid` : sql``}
       order by r.at desc
       limit 200`)
    return rows.map((row) => ({
      id: String(row.id),
      automationId: String(row.automationId),
      automationName: String(row.automation_name),
      entityType: String(row.entityType),
      entityId: String(row.entityId),
      state: row.state,
      detail: row.detail,
      at: row.at instanceof Date ? row.at : new Date(String(row.at)),
    }))
  })

/** Gated the same way the rules themselves are: a rule that writes to records is
 *  an admin's to make. */
export const assertMayAutomate = (ctx: WorkspaceContext): void => assertCanWrite(ctx, 'automation')
