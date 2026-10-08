'use client'

import { STATE_TONE } from '../../run-state.ts'
import { Badge, DataTable, EmptyState, type Column } from '@rawr/ui'
import Link from 'next/link'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { FilterChip } from '~/components/filter-chip.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { recordPath } from '~/lib/links.ts'
import { useFormat } from '~/components/zone.tsx'

export type RunLogEntry = {
  id: string
  entityType: string
  entityId: string
  entityName: string | null
  state: 'waiting' | 'done' | 'skipped' | 'failed'
  detail: string | null
  /** What each finished step did, in order. A run spanning three days is written
   *  in three pieces, and this is the only place all three are shown. */
  trail: string[]
  resumeAt: string | null
  at: string
}

const FILTERS: { key: string; label: string }[] = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'done', label: 'Done' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'failed', label: 'Failed' },
]

export const RunLog = ({
  runs,
  state,
  capped,
  accountSlug,
}: {
  runs: RunLogEntry[]
  state: string | null
  /** True when the read hit its ceiling, so the page can say that what is missing
   *  is older runs rather than none. */
  capped: boolean
  accountSlug: string
}) => {
  const fmt = useFormat()
  const { page, pager } = usePagedRows(runs, 'runs')

  const columns: Column<RunLogEntry>[] = [
    {
      key: 'record',
      header: 'Record',
      width: 280,
      render: (run) => (
        <Link href={recordPath(accountSlug, run.entityType, run.entityId)} title={run.entityName ?? undefined} className="block truncate font-semibold">
          {run.entityName ?? `This ${run.entityType}`}
        </Link>
      ),
    },
    { key: 'state', header: 'Status', width: 120, render: (run) => <Badge tone={STATE_TONE[run.state]}>{run.state}</Badge> },
    {
      key: 'detail',
      header: 'What it did',
      width: 460,
      render: (run) => (
        <span className="flex min-w-0 flex-col gap-0.5 py-1 font-light">
          {run.trail.map((entry, index) => (
            <span key={`${run.id}-${index}`} className="flex gap-2 break-words">
              <span className="tabular-nums">{index + 1}.</span>
              <span className="min-w-0">{entry}</span>
            </span>
          ))}
          {run.detail ? <span className="break-words text-secondary">{run.detail}</span> : null}
          {run.trail.length === 0 && !run.detail ? EMPTY_VALUE : null}
        </span>
      ),
    },
    {
      key: 'at',
      header: 'Date',
      width: 220,
      // A waiting run's useful time is when it wakes, not when it started:
      // "fired an hour ago" says nothing about a rule that has two more days to sit.
      render: (run) => <span className="font-light">{run.resumeAt ? `Continues ${fmt.dateTime(run.resumeAt)}` : fmt.dateTime(run.at)}</span>,
    },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip
          label="Status"
          clear="?"
          options={FILTERS.map((entry) => ({ key: entry.key, label: entry.label, href: `?state=${entry.key}`, on: state === entry.key }))}
        />
      </div>

      {runs.length === 0 ? (
        <EmptyState
          title={state ? `Nothing ${state}` : 'This rule has not fired yet'}
          description={
            state
              ? 'Other runs may be here under another state.'
              : 'Every firing lands here. Event rules also log firings whose conditions were false.'
          }
        />
      ) : (
        <DataTable columns={columns} rows={page} rowKey={(run) => run.id} caption="Runs" storageKey="settings.automation-runs" />
      )}

      {pager}

      {capped ? (
        <p className="text-small text-secondary">
          The most recent {runs.length} runs. Older ones are still in the account, out of reach of
          this page.
        </p>
      ) : null}
    </div>
  )
}
