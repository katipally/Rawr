'use client'

import { DataTable, EmptyState, NOTHING_MATCHED, type Column } from '@rawr/ui'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { reportsPath } from '~/lib/links.ts'
import { useFormat } from '~/components/zone.tsx'
import { ReportsLibrary, matching } from '../library.tsx'

export type ReportRow = { key: string; name: string; group: string; report: string; dashboards: number }

export const ReportList = ({
  account,
  from,
  to,
  dashboards,
  rows,
}: {
  account: string
  from: string
  to: string
  dashboards: number
  rows: ReportRow[]
}) => {
  const fmt = useFormat()
  const shown = matching(rows, useSearchParams().get('q'))

  const columns: Column<ReportRow>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 360,
      render: (row) => (
        <Link href={reportsPath(account, { tab: row.report, from, to })} title={row.name} className="block min-w-0 truncate py-1 font-semibold">
          {row.name}
        </Link>
      ),
    },
    { key: 'report', header: 'Report', width: 180, render: (row) => row.group },
    { key: 'dashboards', header: 'Dashboards', width: 120, align: 'right', render: (row) => fmt.number(row.dashboards) },
  ]

  return (
    <ReportsLibrary
      account={account}
      from={from}
      to={to}
      current="list"
      counts={{ dashboards, reports: rows.length }}
      title="Reports"
    >
      <DataTable
        columns={columns}
        rows={shown}
        rowKey={(row) => row.key}
        caption="Reports"
        storageKey="reports.list"
        empty={<EmptyState {...NOTHING_MATCHED} />}
      />
    </ReportsLibrary>
  )
}
