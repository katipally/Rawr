import {
  armedFor,
  claimAutomationRun,
  conditionsHold,
  createTask,
  finishAutomationRun,
  getRecord,
  listLifecycleStages,
  openAutomationRun,
  readAutomation,
  parkAutomationRun,
  updateRecord,
  type AutomationAction,
  type AutomationRow,
  type AutomationTrigger,
  type ObjectKey,
  type WorkspaceContext,
} from '@rawr/db'
import { inBackground } from './background.ts'
import { notifySubscribers } from './webhooks.ts'
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

/** Walks the steps from `from`, and returns when it either finishes or parks.
 *
 *  The one function both entry points use: the trigger runs it from step zero,
 *  and the dispatcher runs it from wherever a delay left it. A run that never
 *  waits does the whole list in one pass, which is exactly what a rule did before
 *  delays existed.
 *
 *  A failure stops the rest, unchanged: an automation half-applied leaves a
 *  record in a state no rule describes, which is worse than one that did not run.
 *  The trail says how far it got. */
export const walkSteps = async (
  ctx: WorkspaceContext,
  event: AutomationEvent,
  rule: AutomationRow,
  runId: string,
  from: number,
  trail: string[],
  name: string,
): Promise<void> => {
  const done = [...trail]
  try {
    for (let i = from; i < rule.steps.length; i += 1) {
      const step = rule.steps[i]
      if (!step) continue

      if (step.kind === 'delay') {
        await parkAutomationRun(ctx, runId, {
          stepIndex: i + 1,
          resumeAt: new Date(Date.now() + step.minutes * 60_000),
          trail: [...done, `waited ${describeDelay(step.minutes)}`],
        })
        return
      }

      if (step.kind === 'guard') {
        // Judged against the record as it is now, which after a delay is the
        // whole point: three days later it may have been won, reassigned or
        // deleted, and a guard reading a copy from before the wait would be a
        // guard that lies.
        if (!(await conditionsHold(ctx, event.objectKey, event.entityId, step.conditions))) {
          await finishAutomationRun(ctx, runId, {
            state: 'skipped',
            stepIndex: i,
            trail: done,
            detail: [...done, 'stopped: the record no longer matches'].join(', '),
          })
          return
        }
        done.push('checked the record still matches')
        continue
      }

      done.push(await runAction(ctx, event, step, rule.id, name))
    }

    await finishAutomationRun(ctx, runId, { state: 'done', stepIndex: rule.steps.length, trail: done })
  } catch (cause) {
    await finishAutomationRun(ctx, runId, {
      state: 'failed',
      stepIndex: from,
      trail: done,
      detail: cause instanceof Error ? cause.message : String(cause),
    }).catch(() => {
      // The database is the last place to record this. If it is unreachable the
      // write that triggered the rule has already succeeded, which is the part
      // that mattered.
    })
  }
}

/** "3 days", "2 hours", "20 minutes". For the run log, which a person reads. */
const describeDelay = (minutes: number): string => {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440
    return `${days} day${days === 1 ? '' : 's'}`
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

const runOne = async (
  ctx: WorkspaceContext,
  event: AutomationEvent,
  rule: AutomationRow,
  name: string,
): Promise<void> => {
  const runId = await openAutomationRun(ctx, {
    automationId: rule.id,
    entityType: event.objectKey,
    entityId: event.entityId,
  })

  if (!(await conditionsHold(ctx, event.objectKey, event.entityId, rule.conditions))) {
    await finishAutomationRun(ctx, runId, {
      state: 'skipped',
      stepIndex: 0,
      trail: [],
      detail: 'The conditions did not hold for this record.',
    })
    return
  }

  await walkSteps(ctx, event, rule, runId, 0, [], name)
}

/** Pick a parked run back up. Called by the worker through the internal route,
 *  never by a request.
 *
 *  Every reason not to continue is answered the same way: end the run with a
 *  sentence saying why. A rule switched off, deleted, or pointing at a record
 *  that has since gone are all ordinary, and none of them is a failure to retry. */
export const resumeAutomation = async (
  ctx: WorkspaceContext,
  runId: string,
  workspaceSlug: string,
): Promise<{ resumed: boolean; reason?: string }> => {
  const claimed = await claimAutomationRun(ctx, runId)
  // Somebody else has it, or it is not due. Not an error: the dispatcher is
  // allowed to be optimistic and the lease is what settles it.
  if (!claimed) return { resumed: false, reason: 'not due, or already in flight' }

  const rule = await readAutomation(ctx, claimed.automationId)
  if (!rule || !rule.isActive) {
    await finishAutomationRun(ctx, runId, {
      state: 'skipped',
      stepIndex: claimed.stepIndex,
      trail: claimed.trail,
      detail: [...claimed.trail, rule ? 'stopped: the rule was switched off' : 'stopped: the rule was deleted'].join(', '),
    })
    return { resumed: false, reason: 'the rule is no longer running' }
  }

  const record = await getRecord(ctx, claimed.entityType, claimed.entityId)
  if (!record) {
    await finishAutomationRun(ctx, runId, {
      state: 'skipped',
      stepIndex: claimed.stepIndex,
      trail: claimed.trail,
      detail: [...claimed.trail, 'stopped: the record was deleted while it waited'].join(', '),
    })
    return { resumed: false, reason: 'the record is gone' }
  }

  await walkSteps(
    ctx,
    {
      trigger: rule.trigger,
      objectKey: claimed.entityType,
      entityId: claimed.entityId,
      displayName: record.displayName,
      workspaceSlug,
    },
    rule,
    runId,
    claimed.stepIndex,
    claimed.trail,
    record.displayName,
  )
  return { resumed: true }
}

/** Report one thing that happened, to everything that cares about it.
 *
 *  Two consumers now: the rules inside Rawr, and whatever is subscribed outside
 *  it. One call site per event rather than two, so a place that reports an event
 *  cannot be updated for one and forgotten for the other — which is exactly how
 *  a webhook that fires on three of four triggers happens.
 *
 *  Never awaited by a request. */
export const reportEvent = (ctx: WorkspaceContext, event: AutomationEvent | undefined): void => {
  if (!event) return
  runAutomations(ctx, event)
  notifySubscribers(ctx, {
    objectKey: event.objectKey,
    trigger: event.trigger,
    entityId: event.entityId,
    workspaceSlug: event.workspaceSlug,
  })
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
