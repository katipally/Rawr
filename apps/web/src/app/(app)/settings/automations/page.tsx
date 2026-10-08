import {
  canView,
  listAssignable,
  listAutomationRuns,
  listAutomations,
  listEmailTemplates,
  listFields,
  listLifecycleStages,
  listMailboxes,
  listSequences,
  getRegistry,
  isSettableField,
  MAX_DELAY_MINUTES,
  type AutomationStep,
} from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { AutomationList, type StepView } from './automation-list.tsx'
import { delayFrom } from './wait-input.ts'

/** How many runs the Recent activity card shows. One more is read, to know whether the all-runs page has more. */
const RECENT_RUNS = 50
import { toFilterFields } from '~/server/crm.ts'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'

/** The editor holds every config value as a string, because each one came out of
 *  an input. The server coerces on the way back in. Recursive, because a branch
 *  holds two arms of exactly these steps. */
const asStepView = (step: AutomationStep): StepView => {
  if (step.kind === 'delay') return { kind: 'delay', ...delayFrom(step.minutes) }
  if (step.kind === 'guard') return { kind: 'guard', conditions: step.conditions }
  if (step.kind === 'branch') {
    return {
      kind: 'branch',
      conditions: step.conditions,
      matched: step.matched.map(asStepView),
      otherwise: step.otherwise.map(asStepView),
    }
  }
  return {
    kind: 'action',
    type: step.type,
    config: Object.fromEntries(Object.entries(step.config).map(([key, value]) => [key, String(value ?? '')])),
  }
}

/** B11. When this happens, do that.
 *
 *  Everything automatic in Rawr before this was hard-wired. This is the screen
 *  that lets a rule exist without a deploy. */
const AutomationsPage = async () => {
  const session = await readSession()
  if (!session) return null

  if (!sessionIsAdmin(session)) {
    return (
      <EmptyState
        title="Automations are admin only"
        description="You need account admin access to see these. You can still change records one at a time. A rule changes every record that matches it."
      />
    )
  }

  const ctx = contextFrom(session)
  const [rows, runs, people, stages, fields, registry, templates, mailboxes, sequences] = await Promise.all([
    listAutomations(ctx),
    listAutomationRuns(ctx, { limit: RECENT_RUNS + 1 }),
    listAssignable(ctx),
    listLifecycleStages(ctx),
    listFields(ctx),
    getRegistry(ctx),
    canView(ctx, 'sales') ? listEmailTemplates(ctx) : [],
    listMailboxes(ctx),
    canView(ctx, 'sales') ? listSequences(ctx) : [],
  ])

  // Every object in the account, not the three written out: "a record is
  // created" happens to an object an admin invented exactly as it does to a
  // contact.
  const objects = registry.objects.map((object) => ({ key: object.key, label: object.nameSingular }))
  // Only the fields a set-field step can write. A relation, a user field or a
  // rating needs an id or a shape a text box cannot give, so it is not offered.
  const fieldsByObject = Object.fromEntries(
    registry.objects.map((object) => [
      object.key,
      fields
        .filter((field) => field.objectKey === object.key && isSettableField(field))
        .map((field) => ({ key: field.key, label: field.label, type: field.type, options: field.options })),
    ]),
  )
  // Only the date fields, for the trigger that waits for one to arrive. A rule
  // pointed at an object with none of them has nothing to pick, which the empty
  // dropdown says on its own.
  const dateFieldsByObject = Object.fromEntries(
    registry.objects.map((object) => [
      object.key,
      fields
        .filter((field) => field.objectKey === object.key && (field.type === 'date' || field.type === 'datetime'))
        .map((field) => ({ key: field.key, label: field.label })),
    ]),
  )
  // The same shape segments use, because the conditions are the same filter
  // language against the same object, and the page's own copy says so.
  const filterFieldsByObject = Object.fromEntries(
    registry.objects.map((object) => [object.key, toFilterFields(object)]),
  )

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Automations"
        lead="When this happens, do that."
        why={
          <>
            <p>
              Most rules fire on the write that triggered them, so nothing polls. Two do not: a date
              arriving and a record going quiet are absences, and no write announces either. Rawr
              looks for those once an hour, and fires each rule at most once a day per record.
            </p>
            <p>
              Conditions use the same filter language segments do. Steps run in order and a
              failure stops the rest, because a rule half-applied leaves a record in a state no rule
              describes. An event rule logs every firing, including the ones whose conditions were
              false. A date or silence rule logs only the records it fires on.
            </p>
            <p>
              A rule can wait. A step that waits parks the record and the worker picks it up when
              the time comes, and a step that checks looks at the record again as it is then, so
              &ldquo;wait three days, and if they still have not replied, make a task&rdquo; is
              three steps in a row. A run still waiting shows in the log before the finished ones.
            </p>
          </>
        }
      />

      <AutomationList
        accountSlug={session.accountSlug}
        maxWaitMinutes={MAX_DELAY_MINUTES}
        rows={rows.map((row) => ({
          ...row,
          triggerConfig: Object.fromEntries(
            Object.entries(row.triggerConfig).map(([key, value]) => [key, String(value ?? '')]),
          ),
          steps: row.steps.map(asStepView),
          createdAt: row.createdAt.toISOString(),
          lastRunAt: row.lastRunAt?.toISOString() ?? null,
        }))}
        runs={runs.slice(0, RECENT_RUNS).map((run) => ({
          ...run,
          resumeAt: run.resumeAt?.toISOString() ?? null,
          at: run.at.toISOString(),
        }))}
        moreRuns={runs.length > RECENT_RUNS}
        people={people.map((person) => ({ id: person.userId, name: person.name }))}
        stages={stages.map((stage) => stage.name)}
        objects={objects}
        fieldsByObject={fieldsByObject}
        dateFieldsByObject={dateFieldsByObject}
        filterFieldsByObject={filterFieldsByObject}
        templates={templates.map((template) => ({ id: template.id, name: template.name }))}
        mailboxes={mailboxes
          .filter((box) => box.canSend && box.state !== 'revoked')
          .map((box) => ({ id: box.id, email: box.email }))}
        sequences={sequences.map((entry) => ({ id: entry.id, name: entry.name }))}
      />
    </div>
  )
}

export default AutomationsPage
