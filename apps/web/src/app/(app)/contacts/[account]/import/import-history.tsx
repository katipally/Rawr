'use client'

import { Avatar, DataTable, EmptyState, NOTHING_MATCHED, type Column } from '@rawr/ui'
import { Search } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { StatusDot, type StatusTone } from '~/components/row-actions.tsx'
import { useFormat } from '~/components/zone.tsx'
import { importsPath } from '~/lib/links.ts'

export type ImportHistoryRow = {
  id: string
  filename: string
  what: string
  state: 'uploading' | 'parsing' | 'mapping' | 'previewing' | 'running' | 'done' | 'failed' | 'cancelled'
  uploadedBytes: number
  fileBytes: number
  totalRows: number
  processedRows: number
  created: number
  updated: number
  skipped: number
  errored: number
  createdByName: string | null
  createdAt: string
}

const STATE: Record<ImportHistoryRow['state'], { label: string; tone: StatusTone }> = {
  uploading: { label: 'Uploading', tone: 'pending' },
  parsing: { label: 'Reading', tone: 'pending' },
  mapping: { label: 'Needs mapping', tone: 'off' },
  previewing: { label: 'Needs mapping', tone: 'off' },
  running: { label: 'Importing', tone: 'pending' },
  done: { label: 'Done', tone: 'live' },
  failed: { label: 'Failed', tone: 'error' },
  cancelled: { label: 'Stopped', tone: 'archived' },
}

/** HubSpot's file imports table: the name as a link, a dot for the state, the
 *  counts with nothing as "--", who started it and when. Searched and paged in
 *  the browser over every run the page was given. */
export const ImportHistory = ({ account, runs }: { account: string; runs: ImportHistoryRow[] }) => {
  const fmt = useFormat()
  const [needle, setNeedle] = useState('')
  const wanted = needle.trim().toLowerCase()
  const visible = wanted
    ? runs.filter((run) => run.filename.toLowerCase().includes(wanted) || run.what.toLowerCase().includes(wanted))
    : runs
  const { page, pager } = usePagedRows(visible, 'imports')

  const count = (value: number) => (value === 0 ? EMPTY_VALUE : fmt.number(value))

  const columns: Column<ImportHistoryRow>[] = [
    {
      key: 'name',
      header: 'Import name',
      width: 280,
      render: (run) => (
        <Link href={importsPath(account, run.id)} title={run.filename} className="block truncate font-semibold">
          {run.filename}
        </Link>
      ),
    },
    { key: 'what', header: 'Object', width: 180, render: (run) => <span className="block truncate">{run.what}</span> },
    {
      key: 'state',
      header: 'Import state',
      width: 160,
      render: (run) => <StatusDot tone={STATE[run.state].tone}>{STATE[run.state].label}</StatusDot>,
    },
    {
      key: 'rows',
      header: 'Rows',
      width: 150,
      align: 'right',
      // A file that is still arriving has no rows yet, so what it has at that
      // point is bytes, and that is what it says.
      render: (run) =>
        run.state === 'uploading'
          ? `${fmt.bytes(run.uploadedBytes)} / ${fmt.bytes(run.fileBytes)}`
          : run.state === 'running'
            ? `${fmt.number(run.processedRows)} / ${fmt.number(run.totalRows)}`
            : count(run.totalRows),
    },
    { key: 'created', header: 'New records', width: 130, align: 'right', render: (run) => count(run.created) },
    { key: 'updated', header: 'Updated records', width: 150, align: 'right', render: (run) => count(run.updated) },
    { key: 'skipped', header: 'Skipped', width: 110, align: 'right', render: (run) => count(run.skipped) },
    { key: 'errors', header: 'Errors', width: 100, align: 'right', render: (run) => count(run.errored) },
    {
      key: 'by',
      header: 'Created by',
      width: 200,
      render: (run) =>
        run.createdByName ? (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar name={run.createdByName} size="sm" />
            <span className="truncate">{run.createdByName}</span>
          </span>
        ) : (
          EMPTY_VALUE
        ),
    },
    {
      key: 'at',
      header: 'Created',
      width: 200,
      render: (run) => <span className="whitespace-nowrap">{fmt.dateTime(run.createdAt)}</span>,
    },
  ]

  if (runs.length === 0) {
    return (
      <EmptyState
        title="Nothing has been imported yet"
        description="An import runs on the server, so you can close this tab and come back to it."
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <label className="relative w-full min-w-0 sm:w-60">
        <span className="sr-only">Search imports</span>
        <input
          type="search"
          value={needle}
          placeholder="Search"
          onChange={(event) => setNeedle(event.target.value)}
          className="h-control w-full rounded-pill border border-line-strong bg-surface py-1 pr-9 pl-4 text-body placeholder:text-muted"
        />
        <Search aria-hidden="true" className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />
      </label>
      <DataTable
        columns={columns}
        rows={page}
        rowKey={(run) => run.id}
        caption="File imports"
        storageKey="imports.history"
        empty={<EmptyState {...NOTHING_MATCHED} />}
      />
      {pager}
    </div>
  )
}
