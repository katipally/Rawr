'use client'

import { Badge, Button, EmptyState, useToast } from '@rawr/ui'
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
  workspace: string
  rows: DashboardSummary[]
  catalogue: CardChoice[]
  from: string
  to: string
}

export const DashboardList = ({ workspace, rows, catalogue, from, to }: DashboardListProps) => {
  const router = useRouter()
  const toast = useToast()
  const [composing, setComposing] = useState(false)
  const [busy, setBusy] = useState(false)

  const create = async (input: { name: string; cards: string[]; isShared: boolean }) => {
    setBusy(true)
    try {
      const { id } = await api.reporting.dashboards.save.mutate(input)
      setComposing(false)
      router.push(dashboardPath(workspace, id, { from, to }))
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button variant="primary" onClick={() => setComposing(true)}>
          New dashboard
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No dashboards yet"
          description="Pick the figures you check every Monday and put them on one screen."
        />
      ) : (
        <ul className="grid gap-3 @2xl:grid-cols-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <Link
                  href={dashboardPath(workspace, row.id, { from, to })}
                  className="font-semibold text-link"
                >
                  {row.name}
                </Link>
                {row.isShared ? <Badge tone="info">Shared</Badge> : <Badge tone="neutral">Private</Badge>}
              </div>
              <p className="text-small text-secondary">
                {row.cards.length === 1 ? '1 card' : `${row.cards.length} cards`}
                {row.ownerName ? ` · ${row.mine ? 'yours' : row.ownerName}` : ''} · changed{' '}
                {formatDateTime(row.updatedAt)}
              </p>
            </li>
          ))}
        </ul>
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
