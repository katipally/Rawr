'use client'

import { Badge, EmptyState, FilterRow } from '@rawr/ui'
import Link from 'next/link'
import { usePagedRows } from '~/components/paged.tsx'
import { formatDateTime } from '~/components/crm/value.tsx'
import { recordPath } from '~/lib/links.ts'
import { useZone } from '~/components/zone.tsx'

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

const STATE_TONE = { waiting: 'accent', done: 'ok', skipped: 'neutral', failed: 'error' } as const

const FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'All' },
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
  const zone = useZone()
  const { page, pager } = usePagedRows(runs, 'runs')

  return (
    <div className="flex flex-col gap-3">
      <FilterRow
        label="Which runs"
        lead="Showing"
        items={FILTERS.map((entry) => ({
          key: entry.key || 'all',
          label: entry.label,
          href: entry.key ? `?state=${entry.key}` : '?',
          current: (state ?? '') === entry.key,
        }))}
      />

      {runs.length === 0 ? (
        <EmptyState
          title={state ? `Nothing ${state}` : 'This rule has not fired yet'}
          description={
            state
              ? 'Other runs may be here under another state.'
              : 'Every firing lands here, including the ones whose conditions were false.'
          }
        />
      ) : (
        <ol className="flex flex-col rounded-panel border border-line bg-surface">
          {page.map((run) => (
            <li key={run.id} className="flex flex-col gap-1 border-b border-divider px-3 py-2 last:border-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <Badge tone={STATE_TONE[run.state]}>{run.state}</Badge>
                <Link
                  href={recordPath(accountSlug, run.entityType, run.entityId)}
                  className="min-w-0 truncate font-medium"
                >
                  {run.entityName ?? `This ${run.entityType}`}
                </Link>
                {/* A waiting run's useful time is when it wakes, not when it
                    started: "fired an hour ago" says nothing about a rule that
                    has two more days to sit. */}
                <span className="ml-auto shrink-0 text-small text-secondary tabular-nums">
                  {run.resumeAt
                    ? `continues ${formatDateTime(run.resumeAt, zone)}`
                    : formatDateTime(run.at, zone)}
                </span>
              </div>

              {run.trail.length > 0 ? (
                <ol className="flex flex-col gap-0.5 text-small text-secondary">
                  {run.trail.map((entry, index) => (
                    <li key={`${run.id}-${index}`} className="flex gap-2">
                      <span className="tabular-nums">{index + 1}.</span>
                      <span className="min-w-0 break-words">{entry}</span>
                    </li>
                  ))}
                </ol>
              ) : null}

              {run.detail ? <p className="text-small break-words text-secondary">{run.detail}</p> : null}
            </li>
          ))}
        </ol>
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
