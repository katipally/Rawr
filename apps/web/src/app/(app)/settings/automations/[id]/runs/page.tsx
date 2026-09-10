import { listAutomationRuns, readAutomation, RUN_PAGE } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { notFound } from 'next/navigation'
import { RunLog } from './run-log.tsx'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'

const STATES = ['waiting', 'done', 'skipped', 'failed'] as const
type RunState = (typeof STATES)[number]

/** B11. What one rule actually did.
 *
 *  The index carries the last few firings across every rule, which answers "is
 *  anything running". This answers the other question: this rule, this record,
 *  this step, and why it stopped. Its own page because a run's trail is a list of
 *  its own and a hundred of them do not fit beside the editor. */
const AutomationRunsPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ state?: string }>
}) => {
  const session = await readSession()
  if (!session) return null

  if (!sessionIsAdmin(session)) {
    return (
      <EmptyState
        title="Automations are admin only"
        description="You need account access, which you do not have."
      />
    )
  }

  const { id } = await params
  const { state } = await searchParams
  const ctx = contextFrom(session)
  const rule = await readAutomation(ctx, id)
  if (!rule) notFound()

  const filter = STATES.includes(state as RunState) ? (state as RunState) : null
  const runs = await listAutomationRuns(ctx, {
    automationId: id,
    ...(filter ? { state: filter } : {}),
    limit: RUN_PAGE,
  })

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title={rule.name}
        lead="Every time this rule fired, and what it did."
        why={
          <>
            <p>
              A firing is logged whether it did anything or not, because &ldquo;it did not
              run&rdquo; and &ldquo;it ran and the conditions were false&rdquo; are different
              answers to the only question anybody asks about a rule.
            </p>
            <p>
              A run still waiting is one record parked partway through, and it shows above the
              finished ones: what a rule is about to do is more use than what it did last week.
            </p>
          </>
        }
      />
      <RunLog
        accountSlug={session.accountSlug}
        state={filter}
        capped={runs.length >= RUN_PAGE}
        runs={runs.map((run) => ({
          id: run.id,
          entityType: run.entityType,
          entityId: run.entityId,
          entityName: run.entityName,
          state: run.state,
          detail: run.detail,
          trail: run.trail,
          resumeAt: run.resumeAt?.toISOString() ?? null,
          at: run.at.toISOString(),
        }))}
      />
    </div>
  )
}

export default AutomationRunsPage
