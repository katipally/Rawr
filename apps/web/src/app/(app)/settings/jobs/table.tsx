'use client'

import { DataTable, DropdownMenu, EmptyState, Modal, cn, useToast, type Column } from '@rawr/ui'
import { ChevronDown, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ghostFilter } from '~/components/filter-chip.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { RowActions, rowPill } from '~/components/row-actions.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useUrlParam } from '~/lib/url-params.ts'
import { useFormat } from '~/components/zone.tsx'

export type DeadLetter = {
  id: string
  jobName: string
  error: string
  /** Null for work that never reached the queue, so it never had an attempt. */
  attempts: number | null
  at: string
  payload: unknown
}

export const DeadLetterTable = ({ rows }: { rows: DeadLetter[] }) => {
  const fmt = useFormat()
  const toast = useToast()
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [viewing, setViewing] = useState<DeadLetter | null>(null)
  const [query, setQuery] = useState('')
  const [job, setJob] = useUrlParam('job')

  /** Safe to press twice: every replay path is keyed on the work rather than on
   *  the attempt, so a second press is a no-op at the provider. F6 §1. */
  const replay = async (id: string) => {
    setBusyId(id)
    try {
      const result = await api.integrations.replay.mutate({ id })
      toast('success', result.detail)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusyId(null)
    }
  }

  const jobs = [...new Set(rows.map((row) => row.jobName))].sort()
  const needle = query.trim().toLowerCase()
  const shown = rows.filter(
    (row) => (!job || row.jobName === job) && (!needle || row.jobName.toLowerCase().includes(needle) || row.error.toLowerCase().includes(needle)),
  )
  const { page, pager } = usePagedRows(shown, 'jobs')

  const columns: Column<DeadLetter>[] = [
    {
      key: 'jobName',
      header: 'Job',
      width: 300,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <span title={row.jobName} className="min-w-0 flex-1 truncate font-semibold">{row.jobName}</span>
          <RowActions>
            <button type="button" className={rowPill} disabled={busyId !== null} onClick={() => void replay(row.id)}>
              {busyId === row.id ? 'Replaying' : 'Replay'}
            </button>
            <button type="button" className={rowPill} onClick={() => setViewing(row)}>
              View payload
            </button>
          </RowActions>
        </span>
      ),
    },
    { key: 'at', header: 'Failed at', width: 200, render: (row) => <span className="font-light">{fmt.dateTime(row.at)}</span> },
    {
      key: 'attempts',
      header: 'Attempts',
      width: 120,
      align: 'right',
      render: (row) => (row.attempts === null ? <span className="text-secondary">not queued</span> : <span className="font-light tabular-nums">{row.attempts}</span>),
    },
    { key: 'error', header: 'Error', width: 480, render: (row) => <span title={row.error} className="block truncate font-light">{row.error}</span> },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative w-full min-w-0 @lg:w-[18rem]">
          <span className="sr-only">Search failed jobs</span>
          <input
            type="search"
            value={query}
            placeholder="Search job or error"
            onChange={(event) => setQuery(event.target.value)}
            className="h-[2.5rem] w-full rounded-pill border border-line-strong bg-surface py-2 pr-10 pl-4 font-light placeholder:text-muted"
          />
          <Search aria-hidden="true" className="absolute top-1/2 right-4 size-4 -translate-y-1/2" />
        </label>
        {jobs.length > 1 ? (
          <DropdownMenu
            label="Filter by job"
            align="start"
            trigger={(props) => (
              <button {...props} type="button" className={cn(ghostFilter, 'text-body', job && 'bg-fill-hover')}>
                <span className="max-w-64 truncate">{job ? `Job: ${job}` : 'Job'}</span>
                <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
              </button>
            )}
            groups={[
              {
                key: 'jobs',
                items: [
                  { key: '', label: 'All jobs', checked: !job, onSelect: () => setJob(null) },
                  ...jobs.map((name) => ({ key: name, label: name, checked: job === name, onSelect: () => setJob(name) })),
                ],
              },
            ]}
          />
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={page}
        rowKey={(row) => row.id}
        caption="Jobs that could not be delivered"
        storageKey="settings.jobs"
        empty={
          <EmptyState
            title={rows.length === 0 ? 'No failed jobs' : 'No failed job matches'}
            description={
              rows.length === 0
                ? 'Every job has either succeeded or is still retrying. Nothing here needs a person.'
                : 'Try another job or word from the error.'
            }
          />
        }
      />
      {pager}

      <Modal open={viewing !== null} title={viewing?.jobName ?? ''} onClose={() => setViewing(null)}>
        {viewing ? (
          <div className="flex flex-col gap-3">
            <p className="break-words text-secondary">{viewing.error}</p>
            <pre className="max-h-[60vh] overflow-auto rounded-hs border border-line bg-fill p-3 text-small break-all whitespace-pre-wrap">
              {JSON.stringify(viewing.payload, null, 2) ?? 'No payload'}
            </pre>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
