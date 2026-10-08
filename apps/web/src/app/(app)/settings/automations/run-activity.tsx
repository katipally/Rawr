'use client'

import { STATE_TONE } from './run-state.ts'
import { Badge, DataTable, type Column } from '@rawr/ui'
import Link from 'next/link'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { automationRunsPath, recordPath } from '~/lib/links.ts'
import { useFormat } from '~/components/zone.tsx'

export type RunView = {
  id: string
  automationId: string
  automationName: string
  entityType: string
  entityId: string
  /** Null once the record is gone. */
  entityName: string | null
  state: 'waiting' | 'done' | 'skipped' | 'failed'
  detail: string | null
  /** Set only while it is parked, which is what the list leads with. */
  resumeAt: string | null
  at: string
}

/** Status, rule, record, what it did and when. Shared by the Recent activity card
 *  and the all-runs page, so both read the same. The record name is allowed to
 *  truncate; the title shows the whole of it. */
export const RunActivity = ({
  runs,
  accountSlug,
  caption,
  storageKey,
}: {
  runs: RunView[]
  accountSlug: string
  caption: string
  storageKey: string
}) => {
  const fmt = useFormat()

  const columns: Column<RunView>[] = [
    { key: 'state', header: 'Status', width: 120, render: (entry) => <Badge tone={STATE_TONE[entry.state]}>{entry.state}</Badge> },
    {
      key: 'name',
      header: 'Automation',
      width: 260,
      render: (entry) => (
        <Link href={automationRunsPath(entry.automationId)} title={entry.automationName} className="block truncate font-semibold">
          {entry.automationName}
        </Link>
      ),
    },
    {
      key: 'record',
      header: 'Record',
      render: (entry) => (
        <Link href={recordPath(accountSlug, entry.entityType, entry.entityId)} title={entry.entityName ?? undefined} className="block truncate font-semibold">
          {entry.entityName ?? `This ${entry.entityType}`}
        </Link>
      ),
    },
    { key: 'detail', header: 'Detail', width: 420, render: (entry) => <span title={entry.detail ?? undefined} className="block truncate font-light">{entry.detail || EMPTY_VALUE}</span> },
    {
      key: 'at',
      header: 'When',
      width: 220,
      // A waiting run's useful time is when it wakes, not when it started:
      // "fired an hour ago" says nothing about a rule that has two more days to sit.
      render: (entry) => <span className="font-light">{entry.resumeAt ? `Continues ${fmt.dateTime(entry.resumeAt)}` : fmt.dateTime(entry.at)}</span>,
    },
  ]

  return <DataTable columns={columns} rows={runs} rowKey={(entry) => entry.id} caption={caption} storageKey={storageKey} />
}
