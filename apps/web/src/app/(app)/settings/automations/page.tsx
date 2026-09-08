import {
  listAssignable,
  listAutomationRuns,
  listAutomations,
  listFields,
  listLifecycleStages,
  getRegistry,
} from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { AutomationList } from './automation-list.tsx'
import { toFilterFields } from '~/server/crm.ts'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'

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
        description={`You need account access, which you do not have. can change records one at a time. A rule changes every record that matches it.`}
      />
    )
  }

  const ctx = contextFrom(session)
  const [rows, runs, people, stages, fields, registry] = await Promise.all([
    listAutomations(ctx),
    listAutomationRuns(ctx),
    listAssignable(ctx),
    listLifecycleStages(ctx),
    listFields(ctx),
    getRegistry(ctx),
  ])

  // Every object in the account, not the three written out: "a record is
  // created" happens to an object an admin invented exactly as it does to a
  // contact.
  const objects = registry.objects.map((object) => ({ key: object.key, label: object.nameSingular }))
  const fieldsByObject = Object.fromEntries(
    registry.objects.map((object) => [
      object.key,
      fields.filter((field) => field.objectKey === object.key).map((field) => field.key),
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
        as="h2"
        title="Automations"
        lead="When this happens, do that."
        why={
          <>
            <p>
              A rule fires on the write that triggered it, so nothing polls and nothing runs on a
              schedule. That is also why there is no &ldquo;nothing has happened for thirty
              days&rdquo; trigger: it is the one useful rule that is not an event.
            </p>
            <p>
              Conditions use the same filter language segments do. Steps run in order and a
              failure stops the rest, because a rule half-applied leaves a record in a state no rule
              describes. Every firing is logged, including the ones whose conditions were false.
            </p>
            <p>
              A rule can wait. A step that waits parks the record and the worker picks it up when
              the time comes, and a step that checks looks at the record again as it is then — so
              &ldquo;wait three days, and if they still have not replied, make a task&rdquo; is
              three steps in a row. A run still waiting shows in the log before the finished ones.
            </p>
          </>
        }
      />

      <AutomationList
        rows={rows.map((row) => ({
          ...row,
          // The editor holds every config value as a string, because each one came
          // out of an input. The server coerces on the way back in.
          steps: row.steps.map((step) =>
            step.kind === 'action'
              ? {
                  kind: 'action' as const,
                  type: step.type,
                  config: Object.fromEntries(
                    Object.entries(step.config).map(([key, value]) => [key, String(value ?? '')]),
                  ),
                }
              : step.kind === 'delay'
                ? { kind: 'delay' as const, minutes: step.minutes }
                : { kind: 'guard' as const, conditions: step.conditions },
          ),
          createdAt: row.createdAt.toISOString(),
          lastRunAt: row.lastRunAt?.toISOString() ?? null,
        }))}
        runs={runs.map((run) => ({
          ...run,
          resumeAt: run.resumeAt?.toISOString() ?? null,
          at: run.at.toISOString(),
        }))}
        people={people.map((person) => ({ id: person.userId, name: person.name }))}
        stages={stages.map((stage) => stage.name)}
        objects={objects}
        fieldsByObject={fieldsByObject}
        filterFieldsByObject={filterFieldsByObject}
      />
    </div>
  )
}

export default AutomationsPage
