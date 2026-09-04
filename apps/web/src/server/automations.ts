import {
  armedFor,
  conditionsHold,
  createTask,
  getRecord,
  listLifecycleStages,
  recordAutomationRun,
  updateRecord,
  type AutomationAction,
  type AutomationRow,
  type AutomationTrigger,
  type ObjectKey,
  type WorkspaceContext,
} from '@rawr/db'
import { inBackground } from './background.ts'
import { queueHostAlert } from './notify.ts'
import { publicBaseUrl } from '~/lib/env.ts'

/** B11. The half of an automation that actually does something.
 *
 *  Here rather than in the data access layer for the reason the stage alert is:
 *  one of the actions posts to Slack, which needs the notification queue the web
 *  app owns, and the events that trigger a rule are already reported here by the
 *  mutations that caused them.
 *
 *  Run after the response, never inside it. Somebody dragging a card is looking
 *  at the board; a rule that creates three tasks must not make the drag feel
 *  slow, and an automation that throws must never fail the write that triggered
 *  it. Every firing is recorded either way, including the ones whose conditions
 *  were false, because "it did not run" and "it ran and decided not to" are
 *  different answers to the only question anybody asks. */

export type AutomationEvent = {
  trigger: AutomationTrigger
  objectKey: ObjectKey
  entityId: string
  /** The name the record goes by, for the Slack message and the run log. Read at
   *  the trigger where the caller already has it, because by the time an action
   *  has run it may have changed. Omitted by the public capture routes, which
   *  hold an id and nothing else; the runner reads it then, and only if a rule is
   *  actually armed. */
  displayName?: string | undefined
  workspaceSlug: string
}

const text = (config: Record<string, unknown>, key: string): string => {
  const value = config[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** `{{name}}` and nothing else. Deliberately not the sequence engine's merge
 *  fields: those refuse to send rather than leave a gap, which is right for mail
 *  to a person and wrong for a task title only a colleague reads. */
const fill = (template: string, name: string): string =>
  template.replace(/\{\{\s*name\s*\}\}/g, name)

const runAction = async (
  ctx: WorkspaceContext,
  event: AutomationEvent,
  action: AutomationAction,
  ruleId: string,
  name: string,
): Promise<string> => {
  switch (action.type) {
    case 'set_field': {
      const key = text(action.config, 'field')
      if (!key) throw new Error('That action names no field.')
      const value = action.config.value ?? null
      await updateRecord(ctx, event.objectKey, event.entityId, { [key]: value })
      return `set ${key}`
    }

    case 'set_lifecycle': {
      const name = text(action.config, 'stage')
      const stages = await listLifecycleStages(ctx)
      const stage = stages.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase())
      if (!stage) throw new Error(`There is no lifecycle stage called "${name}".`)
      await updateRecord(ctx, event.objectKey, event.entityId, { lifecycle_stage_id: stage.id })
      return `moved to ${stage.name}`
    }

    case 'assign_owner': {
      const userId = text(action.config, 'userId')
      if (!userId) throw new Error('That action names nobody to assign to.')
      await updateRecord(ctx, event.objectKey, event.entityId, { owner_id: userId })
      return 'assigned an owner'
    }

    case 'create_task': {
      const title = fill(text(action.config, 'title') || 'Follow up on {{name}}', name)
      const days = Number(action.config.dueInDays ?? 0)
      const due = Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86_400_000) : null
      await createTask(ctx, {
        title,
        dueDate: due ? due.toISOString().slice(0, 10) : null,
        entity: { entityType: event.objectKey, entityId: event.entityId },
      })
      return `created "${title}"`
    }

    case 'notify_slack': {
      const message = fill(text(action.config, 'message') || '{{name}}', name)
      const link = `/contacts/${event.workspaceSlug}/record/${event.objectKey}/${event.entityId}`
      queueHostAlert({
        workspaceId: ctx.workspaceId,
        jobName: 'slack.automation',
        // Keyed on the rule and the record, so a retry of the same firing posts
        // once. A rule that fires twice for real carries two different records or
        // two different stage moves, and each gets its own key.
        idempotencyKey: `slack:automation:${ruleId}:${event.entityId}`,
        payload: { automationId: ruleId, entityId: event.entityId },
        text: `${message}\n<${publicBaseUrl}${link}|Open in Rawr>`,
        ...(text(action.config, 'channel') ? { channel: text(action.config, 'channel') } : {}),
      })
      return 'posted to Slack'
    }
  }
}

const runOne = async (
  ctx: WorkspaceContext,
  event: AutomationEvent,
  rule: AutomationRow,
  name: string,
): Promise<void> => {
  try {
    if (!(await conditionsHold(ctx, event.objectKey, event.entityId, rule.conditions))) {
      await recordAutomationRun(ctx, {
        automationId: rule.id,
        entityType: event.objectKey,
        entityId: event.entityId,
        state: 'skipped',
        detail: 'The conditions did not hold for this record.',
      })
      return
    }

    // In order, and a failure stops the rest: an automation half-applied leaves a
    // record in a state no rule describes, which is worse than one that did not
    // run at all. The log says how far it got.
    const done: string[] = []
    for (const action of rule.actions) {
      done.push(await runAction(ctx, event, action, rule.id, name))
    }

    await recordAutomationRun(ctx, {
      automationId: rule.id,
      entityType: event.objectKey,
      entityId: event.entityId,
      state: 'done',
      detail: done.join(', '),
    })
  } catch (cause) {
    await recordAutomationRun(ctx, {
      automationId: rule.id,
      entityType: event.objectKey,
      entityId: event.entityId,
      state: 'failed',
      detail: cause instanceof Error ? cause.message : String(cause),
    }).catch(() => {
      // The database is the last place to record this. If it is unreachable the
      // write that triggered the rule has already succeeded, which is the part
      // that mattered.
    })
  }
}

/** Fire everything armed for this event. Never awaited by a request. */
export const runAutomations = (ctx: WorkspaceContext, event: AutomationEvent | undefined): void => {
  if (!event) return
  inBackground(`automations for ${event.objectKey} ${event.entityId}`, async () => {
    const rules = await armedFor(ctx, event.trigger, event.objectKey)
    if (rules.length === 0) return
    // Read once, and only because something is armed: the public capture routes
    // hold a contact id and no name, and reading one per submission whether a
    // rule exists or not is a query on the lead-capture path for nothing.
    const name =
      event.displayName ??
      (await getRecord(ctx, event.objectKey, event.entityId))?.displayName ??
      'this record'
    for (const rule of rules) {
      await runOne(ctx, event, rule, name)
    }
  })
}
