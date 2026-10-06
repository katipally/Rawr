'use client'

import { Button, ConfirmDialog, DataTable, DropdownMenu, EmptyState, NOTHING_MATCHED, useToast, type Column } from '@rawr/ui'
import { ChevronDown } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { RowActions, rowPill } from '~/components/row-actions.tsx'
import { dashboardPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { CardPicker, type CardChoice } from './card-picker.tsx'
import { useFormat } from '~/components/zone.tsx'
import { ReportsLibrary, matching } from '../library.tsx'

export type DashboardSummary = {
  id: string
  name: string
  ownerName: string | null
  isShared: boolean
  cards: string[]
  updatedAt: string
  mine: boolean
  canEdit: boolean
}

export type DashboardListProps = {
  account: string
  rows: DashboardSummary[]
  catalogue: CardChoice[]
  from: string
  to: string
}

type Saved = { name: string; cards: string[]; isShared: boolean }

export const DashboardList = ({ account, rows, catalogue, from, to }: DashboardListProps) => {
  const fmt = useFormat()
  const router = useRouter()
  const toast = useToast()
  const shown = matching(rows, useSearchParams().get('q'))
  // null is closed, 'new' is Create dashboard, a row is its details.
  const [editing, setEditing] = useState<DashboardSummary | 'new' | null>(null)
  const [removing, setRemoving] = useState<DashboardSummary | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (input: Saved) => {
    setBusy(true)
    try {
      if (editing === 'new') {
        const { id } = await api.reporting.dashboards.save.mutate(input)
        router.push(dashboardPath(account, id, { from, to }))
      } else if (editing) {
        await api.reporting.dashboards.save.mutate({ id: editing.id, ...input })
        router.refresh()
      }
      setEditing(null)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setBusy(true)
    try {
      await api.reporting.dashboards.remove.mutate({ id })
      router.refresh()
      setRemoving(null)
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
      width: 360,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <Link href={dashboardPath(account, row.id, { from, to })} title={row.name} className="min-w-0 truncate font-semibold">
            {row.name}
          </Link>
          {row.canEdit ? (
            <RowActions>
              <DropdownMenu
                label={`Actions for ${row.name}`}
                align="start"
                groups={[
                  { key: 'edit', items: [{ key: 'details', label: 'Dashboard details', onSelect: () => setEditing(row) }] },
                  { key: 'remove', items: [{ key: 'delete', label: 'Delete', destructive: true, onSelect: () => setRemoving(row) }] },
                ]}
                trigger={(props) => (
                  <button {...props} type="button" className={rowPill}>
                    Actions
                    <ChevronDown aria-hidden="true" className="size-3" />
                  </button>
                )}
              />
            </RowActions>
          ) : null}
        </span>
      ),
    },
    { key: 'cards', header: 'Reports', width: 100, align: 'right', render: (row) => fmt.number(row.cards.length) },
    { key: 'owner', header: 'Owner', width: 180, render: (row) => (row.mine ? 'You' : (row.ownerName ?? 'Account')) },
    { key: 'assigned', header: 'Assigned', width: 160, render: (row) => (row.isShared ? 'Everyone' : 'Only the owner') },
    { key: 'updated', header: 'Last updated', width: 200, render: (row) => fmt.dateTime(row.updatedAt) },
  ]

  const details = editing === 'new' ? null : editing

  return (
    <ReportsLibrary
      account={account}
      from={from}
      to={to}
      current="dashboards"
      counts={{ dashboards: rows.length, reports: catalogue.length }}
      title="Dashboards"
      action={
        <Button variant="primary" onClick={() => setEditing('new')}>
          Create dashboard
        </Button>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          title="No dashboards yet"
          description="Pick the figures you check every Monday and put them on one screen."
        />
      ) : (
        <DataTable
          columns={columns}
          rows={shown}
          rowKey={(row) => row.id}
          caption="Dashboards"
          storageKey="reports.dashboards"
          empty={<EmptyState {...NOTHING_MATCHED} />}
        />
      )}

      <CardPicker
        open={editing !== null}
        busy={busy}
        catalogue={catalogue}
        initial={{ name: details?.name ?? '', cards: details?.cards ?? [], isShared: details?.isShared ?? false }}
        title={details ? 'Dashboard details' : 'Create dashboard'}
        onClose={() => setEditing(null)}
        onSave={(input) => void save(input)}
      />

      <ConfirmDialog
        open={removing !== null}
        title={`Delete “${removing?.name ?? 'this dashboard'}”?`}
        confirm="Delete"
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing.id)}
      >
        <p>The reports on it stay in the reports list.</p>
      </ConfirmDialog>
    </ReportsLibrary>
  )
}
