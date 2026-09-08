'use client'

import { Badge, Button, DataTable, EmptyState, useToast, type Column } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { formatDateTime } from '~/components/crm/value.tsx'
import { dashboardPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { CardPicker, type CardChoice } from './card-picker.tsx'

export type DashboardSummary = {
  id: string
  name: string
  ownerName: string | null
  isShared: boolean
  cards: string[]
  updatedAt: string
  mine: boolean
}

export type DashboardListProps = {
  account: string
  rows: DashboardSummary[]
  catalogue: CardChoice[]
  from: string
  to: string
}

export const DashboardList = ({ account, rows, catalogue, from, to }: DashboardListProps) => {
  const router = useRouter()
  const toast = useToast()
  const [composing, setComposing] = useState(false)
  const [busy, setBusy] = useState(false)

  const create = async (input: { name: string; cards: string[]; isShared: boolean }) => {
    setBusy(true)
    try {
      const { id } = await api.reporting.dashboards.save.mutate(input)
      setComposing(false)
      router.push(dashboardPath(account, id, { from, to }))
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const columns: Column<DashboardSummary>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 320,
      render: (row) => (
        <Link href={dashboardPath(account, row.id, { from, to })} className="font-semibold" onClick={(event) => event.stopPropagation()}>
          {row.name}
        </Link>
      ),
    },
    { key: 'owner', header: 'Owner', width: 180, render: (row) => (row.mine ? 'You' : (row.ownerName ?? <span className="text-secondary">Account</span>)) },
    {
      key: 'access',
      header: 'Access',
      width: 120,
      render: (row) => (row.isShared ? <Badge tone="info">Shared</Badge> : <Badge tone="neutral">Private</Badge>),
    },
    { key: 'cards', header: 'Reports', width: 100, align: 'right', render: (row) => row.cards.length },
    { key: 'updated', header: 'Last updated', width: 200, render: (row) => formatDateTime(row.updatedAt) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-secondary">{rows.length === 1 ? '1 dashboard' : `${rows.length} dashboards`}</p>
        <Button variant="primary" onClick={() => setComposing(true)}>
          Create dashboard
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No dashboards yet"
          description="Pick the figures you check every Monday and put them on one screen."
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          caption="Dashboards"
          onRowClick={(row) => router.push(dashboardPath(account, row.id, { from, to }))}
        />
      )}

      <CardPicker
        open={composing}
        busy={busy}
        catalogue={catalogue}
        initial={{ name: '', cards: [], isShared: false }}
        title="New dashboard"
        onClose={() => setComposing(false)}
        onSave={create}
      />
    </div>
  )
}
