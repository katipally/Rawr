'use client'

import { EmptyState, Pagination } from '@rawr/ui'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { FilterChip } from '~/components/filter-chip.tsx'
import { useFormat } from '~/components/zone.tsx'
import { RunActivity, type RunView } from '../run-activity.tsx'

const FILTERS = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'done', label: 'Done' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'failed', label: 'Failed' },
]

/** One page of runs, the Status filter, and the pager. The filter drops the page
 *  number from the address, so a new filter starts at its first page. */
export const AllRuns = ({
  runs,
  accountSlug,
  state,
  offset,
  perPage,
  hasMore,
}: {
  runs: RunView[]
  accountSlug: string
  state: string | null
  offset: number
  perPage: number
  hasMore: boolean
}) => {
  const fmt = useFormat()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const go = (skip: number) => {
    const next = new URLSearchParams(params)
    if (skip > 0) next.set('skip', String(skip))
    else next.delete('skip')
    const query = next.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip
          label="Status"
          clear="?"
          options={FILTERS.map((entry) => ({ ...entry, href: `?state=${entry.key}`, on: state === entry.key }))}
        />
      </div>

      {runs.length === 0 ? (
        <EmptyState
          title={state ? `Nothing ${state}` : 'Nothing has fired yet'}
          description={state ? 'Other runs may be here under another state.' : 'Every firing lands here, across all rules.'}
        />
      ) : (
        <RunActivity runs={runs} accountSlug={accountSlug} caption="All automation runs" storageKey="settings.automation-runs-all" />
      )}

      {offset > 0 || hasMore ? (
        <Pagination
          format={fmt.number}
          count={runs.length}
          offset={offset}
          hasMore={hasMore}
          perPage={perPage}
          noun="runs"
          onPrevious={() => go(Math.max(0, offset - perPage))}
          onNext={() => go(offset + perPage)}
        />
      ) : null}
    </div>
  )
}
