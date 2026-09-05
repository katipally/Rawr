import {
  listAssignable,
  listAutomationRuns,
  listAutomations,
  listFields,
  listLifecycleStages,
} from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { AutomationList } from './automation-list.tsx'
import { contextFrom, readSession } from '~/server/session.ts'

/** B11. When this happens, do that.
 *
 *  Everything automatic in Rawr before this was hard-wired. This is the screen
 *  that lets a rule exist without a deploy. */
const AutomationsPage = async () => {
  const session = await readSession()
  if (!session) return null

  if (session.role !== 'admin') {
    return (
      <EmptyState
        title="Automations are admin only"
        description={`Your role (${session.role}) can change records one at a time. A rule changes every record that matches it.`}
      />
    )
  }

  const ctx = contextFrom(session)
  const [rows, runs, people, stages, fields] = await Promise.all([
    listAutomations(ctx),
    listAutomationRuns(ctx),
    listAssignable(ctx),
    listLifecycleStages(ctx),
    listFields(ctx),
  ])

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
                : { kind: 'guard' as const },
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
        fieldsByObject={{
          contact: fields.filter((field) => field.objectKey === 'contact').map((field) => field.key),
          company: fields.filter((field) => field.objectKey === 'company').map((field) => field.key),
          deal: fields.filter((field) => field.objectKey === 'deal').map((field) => field.key),
        }}
      />
    </div>
  )
}

export default AutomationsPage
