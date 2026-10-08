import { listAutomationRuns, type AutomationRunState } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { ChevronLeft } from 'lucide-react'
import Link from 'next/link'
import { automationsPath } from '~/lib/links.ts'
import { AllRuns } from './all-runs.tsx'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'

const PAGE = 50
const STATES: AutomationRunState[] = ['waiting', 'done', 'skipped', 'failed']

/** Every automation's runs, newest first with the waiting ones on top. The same
 *  columns as Recent activity on the Automations page, paged from the database. */
const AllAutomationRunsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; skip?: string }>
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

  const { state, skip } = await searchParams
  const filter = STATES.find((entry) => entry === state) ?? null
  const offset = Math.max(0, Math.floor(Number(skip)) || 0)
  // One more than a page, so the reader knows whether a next page exists.
  const runs = await listAutomationRuns(contextFrom(session), {
    ...(filter ? { state: filter } : {}),
    limit: PAGE + 1,
    offset,
  })

  return (
    <div className="flex flex-col gap-4">
      <Link href={automationsPath()} className="inline-flex items-center gap-1 self-start font-semibold">
        <ChevronLeft aria-hidden="true" className="size-4" />
        Back to Automations
      </Link>
      <PageHeader
        title="Automation runs"
        lead="Every time a rule fired, across all of them."
        why={
          <p>
            Runs still waiting sit at the top, because what a rule is about to do is more use than
            what it did last week. Each row names the record and the rule, so a run can be traced
            without opening the rule.
          </p>
        }
      />
      <AllRuns
        accountSlug={session.accountSlug}
        state={filter}
        offset={offset}
        perPage={PAGE}
        hasMore={runs.length > PAGE}
        runs={runs.slice(0, PAGE).map((run) => ({
          ...run,
          resumeAt: run.resumeAt?.toISOString() ?? null,
          at: run.at.toISOString(),
        }))}
      />
    </div>
  )
}

export default AllAutomationRunsPage
