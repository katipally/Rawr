import {
  armedFor,
  armedScans,
  automationEmailTemplate,
  claimAutomationRun,
  conditionsHold,
  createTask,
  enroll,
  finishAutomationRun,
  getRecord,
  listLifecycleStages,
  openAutomationRun,
  openScannedRun,
  readAutomation,
  parkAutomationRun,
  readMailbox,
  readSubscriptions,
  renderMergeFields,
  scanTargets,
  updateRecord,
  type AutomationAction,
  type AutomationRow,
  type AutomationStep,
  type AutomationTrigger,
  type AccountContext,
  type MergeFieldKey,
  type StepPath,
} from '@rawr/db'
import { inBackground } from './background.ts'
import { compose } from './sequences/compose.ts'
import { notifySubscribers, signPayload } from './webhooks.ts'
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
  /** An object key, core or invented. */
  objectKey: string
  entityId: string
  /** The name the record goes by, for the Slack message and the run log. Read at
   *  the trigger where the caller already has it, because by the time an action
   *  has run it may have changed. Omitted by the public capture routes, which
   *  hold an id and nothing else; the runner reads it then, and only if a rule is
   *  actually armed. */
  displayName?: string | undefined
  accountSlug: string
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
  ctx: AccountContext,
  event: AutomationEvent,
  action: AutomationAction,
  ruleId: string,
  /** This firing, and where in the rule this step sits. Together they name one
   *  thing that happened once, which is what an idempotency key has to be. */
  runId: string,
  path: StepPath,
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
      const link = `/contacts/${event.accountSlug}/record/${event.objectKey}/${event.entityId}`
      queueHostAlert({
        accountId: ctx.accountId,
        jobName: 'slack.automation',
        // Keyed on the firing and the step, so a retry of the same resume posts
        // once and a rule with two Slack steps posts both. Keyed on the rule and
        // the record instead, the second time a deal reached Proposal was silent
        // for ever, because the key had already been spent.
        idempotencyKey: `slack:automation:${runId}:${path.join('.')}`,
        payload: { automationId: ruleId, entityId: event.entityId },
        text: `${message}\n<${publicBaseUrl}${link}|Open in Rawr>`,
        ...(text(action.config, 'channel') ? { channel: text(action.config, 'channel') } : {}),
      })
      return 'posted to Slack'
    }

    case 'send_email': {
      const to = await contactAddress(ctx, event, name)
      const template = await automationEmailTemplate(ctx, text(action.config, 'templateId'))
      if (!template) throw new Error('That template no longer exists.')

      const mailboxId = text(action.config, 'mailboxId')
      const record = await getRecord(ctx, 'contact', event.entityId)
      const mailbox = mailboxId ? await readMailbox(ctx, mailboxId) : null
      // Every key a sequence step can fill, so the same template reads the same
      // either way. There is no sequence around an automation's mail, and the
      // send refuses an unfilled field, so {{sequence}} needs a fallback here.
      const values: Record<MergeFieldKey, string | null> = {
        first_name: asText(record?.values.first_name),
        last_name: asText(record?.values.last_name),
        full_name: name,
        email: to,
        company: asText(record?.labels.company_id),
        sender_email: mailbox?.email ?? null,
        sequence: null,
      }
      const subject = renderMergeFields(template.subject, values)
      const body = renderMergeFields(template.bodyText, values)
      const missing = [...new Set([...subject.missing, ...body.missing])]
      if (missing.length > 0) {
        // The sequence engine's rule, for the sequence engine's reason: better a
        // stopped run somebody can see than "Hi ," in a stranger's inbox.
        throw new Error(
          `Nothing to put in ${missing.join(', ')} for this contact. Give the field a fallback, like {{first_name|there}}.`,
        )
      }

      await compose(ctx, {
        mailboxId,
        to,
        subject: subject.text,
        text: body.text,
        contactId: event.entityId,
      })
      return `emailed ${to}`
    }

    case 'enroll_in_sequence': {
      await contactAddress(ctx, event, name)
      const [outcome] = await enroll(ctx, {
        sequenceId: text(action.config, 'sequenceId'),
        contactIds: [event.entityId],
        mailboxId: text(action.config, 'mailboxId'),
      })
      // Opted out, already in it, no address: every one of those comes back as a
      // sentence, and the run log is where somebody reads it.
      if (!outcome?.enrolled) throw new Error(outcome?.reason ?? 'That contact could not be enrolled.')
      return 'enrolled in the sequence'
    }

    case 'webhook': {
      const url = text(action.config, 'url')
      const body = JSON.stringify({
        automation: ruleId,
        at: new Date().toISOString(),
        account: event.accountSlug,
        object: event.objectKey,
        id: event.entityId,
        name,
      })
      await postWebhook(url, text(action.config, 'secret'), body)
      return `called ${new URL(url).host}`
    }
  }
}

const asText = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** Where a rule writes to a person rather than to a record. Both refusals are the
 *  sentences the rest of Rawr already uses for them, because the run log is read
 *  by whoever wrote the rule and not by whoever wrote the code. */
const contactAddress = async (ctx: AccountContext, event: AutomationEvent, name: string): Promise<string> => {
  if (event.objectKey !== 'contact') throw new Error(`Only a contact can be written to, not a ${event.objectKey}.`)
  const record = await getRecord(ctx, 'contact', event.entityId)
  const to = asText(record?.values.email)
  if (!to) throw new Error(`${name} has no email address.`)
  // No subscription type is named on a template, so any opt-out counts. An
  // internal type is not mail to the person and is left out of the question.
  const rows = await readSubscriptions(ctx, event.entityId)
  if (rows.some((row) => !row.isInternal && row.state === 'unsubscribed')) {
    throw new Error('They have opted out of this kind of mail.')
  }
  return to
}

/** One POST, one retry, and five seconds either way.
 *
 *  Short because a run holds nothing open while it waits and the next step is
 *  behind it: a receiver slower than five seconds is one whose answer this rule
 *  cannot use. One retry, because the failure worth retrying is the connection
 *  that dropped, and a receiver answering 500 twice is not going to answer 200
 *  on the third. */
const postWebhook = async (url: string, secret: string, body: string): Promise<void> => {
  const once = async (): Promise<void> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Rawr-Automations/1',
        'rawr-signature': signPayload(secret, body),
      },
      body,
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error(`${url} answered ${response.status}.`)
  }
  try {
    await once()
  } catch {
    await once()
  }
}

/** What one level of the walk decided. `continue` means the level above carries
 *  on at its own next step; the other two mean the run is over or asleep and
 *  nothing further should happen. */
type Walked = 'continue' | 'parked' | 'stopped'

/** One list of steps, which may be the rule's or one arm of a branch inside it.
 *
 *  `prefix` is where this list sits in the rule and `resume` is what is left of
 *  the path a parked run was holding, so a run that slept inside the else arm of
 *  a branch wakes inside that arm rather than at the top. Recursion depth is the
 *  branch depth, which the save path caps.
 *
 *  A failure stops the rest, unchanged: an automation half-applied leaves a
 *  record in a state no rule describes, which is worse than one that did not run.
 *  The trail says how far it got, arms included. */
const walkList = async (
  ctx: AccountContext,
  event: AutomationEvent,
  rule: AutomationRow,
  runId: string,
  steps: AutomationStep[],
  prefix: StepPath,
  resume: StepPath,
  done: string[],
  name: string,
): Promise<Walked> => {
  const head = resume[0]
  const start = typeof head === 'number' ? head : 0

  for (let i = start; i < steps.length; i += 1) {
    const step = steps[i]
    if (!step) continue
    const here: StepPath = [...prefix, i]
    // Only the step the run was parked at inherits the rest of the path; every
    // step after it starts fresh.
    const inner = i === start ? resume.slice(1) : []

    if (step.kind === 'delay') {
      await parkAutomationRun(ctx, runId, {
        stepPath: [...prefix, i + 1],
        resumeAt: new Date(Date.now() + step.minutes * 60_000),
        trail: [...done, `waited ${describeDelay(step.minutes)}`],
      })
      return 'parked'
    }

    if (step.kind === 'guard') {
      // Judged against the record as it is now, which after a delay is the
      // whole point: three days later it may have been won, reassigned or
      // deleted, and a guard reading a copy from before the wait would be a
      // guard that lies.
      if (!(await conditionsHold(ctx, event.objectKey, event.entityId, step.conditions))) {
        await finishAutomationRun(ctx, runId, {
          state: 'skipped',
          stepPath: here,
          trail: done,
          detail: [...done, 'stopped: the record no longer matches'].join(', '),
        })
        return 'stopped'
      }
      done.push('checked the record still matches')
      continue
    }

    if (step.kind === 'branch') {
      // A resumed run takes the arm it already took. Asking again would let a
      // record that changed during the wait finish an arm it never started.
      const arm =
        inner[0] === 'matched' || inner[0] === 'otherwise'
          ? inner[0]
          : (await conditionsHold(ctx, event.objectKey, event.entityId, step.conditions))
            ? 'matched'
            : 'otherwise'
      if (inner.length === 0) {
        done.push(arm === 'matched' ? 'it matched, so took the first road' : 'it did not match, so took the other road')
      }
      const outcome = await walkList(
        ctx,
        event,
        rule,
        runId,
        arm === 'matched' ? step.matched : step.otherwise,
        [...here, arm],
        inner.slice(1),
        done,
        name,
      )
      if (outcome !== 'continue') return outcome
      continue
    }

    done.push(await runAction(ctx, event, step, rule.id, runId, here, name))
  }

  return 'continue'
}

/** Walks the rule from `from`, and returns when it either finishes or parks.
 *
 *  The one function both entry points use: the trigger runs it from the start,
 *  and the dispatcher runs it from wherever a delay left it. A run that never
 *  waits does the whole tree in one pass, which is exactly what a rule did before
 *  delays existed. */
const walkSteps = async (
  ctx: AccountContext,
  event: AutomationEvent,
  rule: AutomationRow,
  runId: string,
  from: StepPath,
  trail: string[],
  name: string,
): Promise<void> => {
  const done = [...trail]
  try {
    const outcome = await walkList(ctx, event, rule, runId, rule.steps, [], from, done, name)
    if (outcome === 'continue') {
      await finishAutomationRun(ctx, runId, { state: 'done', stepPath: [rule.steps.length], trail: done })
    }
  } catch (cause) {
    await finishAutomationRun(ctx, runId, {
      state: 'failed',
      stepPath: from,
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

/** One firing, from an already-opened run. The scan opens its runs differently
 *  from the trigger path, and everything after that is the same. */
const runFrom = async (
  ctx: AccountContext,
  event: AutomationEvent,
  rule: AutomationRow,
  runId: string,
  name: string,
): Promise<void> => {
  if (!(await conditionsHold(ctx, event.objectKey, event.entityId, rule.conditions))) {
    await finishAutomationRun(ctx, runId, {
      state: 'skipped',
      stepPath: [],
      trail: [],
      detail: 'The conditions did not hold for this record.',
    })
    return
  }

  await walkSteps(ctx, event, rule, runId, [], [], name)
}

const runOne = async (
  ctx: AccountContext,
  event: AutomationEvent,
  rule: AutomationRow,
  name: string,
): Promise<void> =>
  runFrom(
    ctx,
    event,
    rule,
    await openAutomationRun(ctx, {
      automationId: rule.id,
      entityType: event.objectKey,
      entityId: event.entityId,
    }),
    name,
  )

/** Pick a parked run back up. Called by the worker through the internal route,
 *  never by a request.
 *
 *  Every reason not to continue is answered the same way: end the run with a
 *  sentence saying why. A rule switched off, deleted, or pointing at a record
 *  that has since gone are all ordinary, and none of them is a failure to retry. */
export const resumeAutomation = async (
  ctx: AccountContext,
  runId: string,
  accountSlug: string,
): Promise<{ resumed: boolean; reason?: string }> => {
  const claimed = await claimAutomationRun(ctx, runId)
  // Somebody else has it, or it is not due. Not an error: the dispatcher is
  // allowed to be optimistic and the lease is what settles it.
  if (!claimed) return { resumed: false, reason: 'not due, or already in flight' }

  const rule = await readAutomation(ctx, claimed.automationId)
  if (!rule || !rule.isActive) {
    await finishAutomationRun(ctx, runId, {
      state: 'skipped',
      stepPath: claimed.stepPath,
      trail: claimed.trail,
      detail: [...claimed.trail, rule ? 'stopped: the rule was switched off' : 'stopped: the rule was deleted'].join(', '),
    })
    return { resumed: false, reason: 'the rule is no longer running' }
  }

  const record = await getRecord(ctx, claimed.entityType, claimed.entityId)
  if (!record) {
    await finishAutomationRun(ctx, runId, {
      state: 'skipped',
      stepPath: claimed.stepPath,
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
      accountSlug,
    },
    rule,
    runId,
    claimed.stepPath,
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
export const reportEvent = (
  ctx: AccountContext,
  // Widened at the door rather than at every call site: a record of a custom
  // object goes through the same create and update procedures, and asking each
  // of them to narrow first would be five copies of the check below.
  event: (Omit<AutomationEvent, 'objectKey'> & { objectKey: string }) | undefined,
): void => {
  if (!event) return
  runAutomations(ctx, event)
  notifySubscribers(ctx, {
    objectKey: event.objectKey,
    trigger: event.trigger,
    entityId: event.entityId,
    accountSlug: event.accountSlug,
  })
}

/** Fire everything armed for this event. Never awaited by a request. */
const runAutomations = (ctx: AccountContext, event: AutomationEvent | undefined): void => {
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

/** The hourly sweep for the two triggers no write announces.
 *
 *  Awaited by the internal route rather than fired into the background, because
 *  the worker is the caller and it is entitled to know how many runs it caused.
 *
 *  Each rule is asked for the records it matches today and each match opens a run
 *  keyed on the day, so the twelve scans between one midnight and the next fire a
 *  rule once. A rule that throws is one rule: the next one still runs, because a
 *  broken date field must not stop every other tenant's silence rule with it.
 *
 *  O(rules x SCAN_LIMIT) records per account per tick, each a sequential scan of
 *  the one object the rule watches. */
export const scanAutomations = async (
  ctx: AccountContext,
  accountSlug: string,
): Promise<{ scanned: number; fired: number }> => {
  const rules = await armedScans(ctx)
  const day = new Date().toISOString().slice(0, 10)
  let fired = 0

  for (const rule of rules) {
    try {
      for (const entityId of await scanTargets(ctx, rule, day)) {
        const runId = await openScannedRun(ctx, {
          automationId: rule.id,
          entityType: rule.objectKey,
          entityId,
          scanDay: day,
        })
        // Already fired for this record today. The unique index said so, which is
        // the only answer two workers scanning the same hour can both trust.
        if (!runId) continue
        const record = await getRecord(ctx, rule.objectKey, entityId)
        if (!record) continue
        fired += 1
        await runFrom(
          ctx,
          {
            trigger: rule.trigger,
            objectKey: rule.objectKey,
            entityId,
            displayName: record.displayName,
            accountSlug,
          },
          rule,
          runId,
          record.displayName,
        )
      }
    } catch (cause) {
      console.error(`[automations] scan of "${rule.name}" failed:`, cause)
    }
  }

  return { scanned: rules.length, fired }
}
