'use client'

import { Alert, Button, ConfirmDialog, cn, DropdownMenu, EmptyState, useToast } from '@rawr/ui'
import { ChevronDown } from 'lucide-react'
import { RangePicker, useRangeLabel } from '~/components/reports/range-picker.tsx'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { dashboardPath, reportsPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { CardPicker, type CardChoice } from '../card-picker.tsx'
import { DashboardSwitcher, type SwitchChoice } from './dashboard-switcher.tsx'
import { ReportCard, type RenderedCard } from './report-card.tsx'

export type DashboardViewProps = {
  account: string
  from: string
  to: string
  catalogue: CardChoice[]
  retired: number
  dashboard: { id: string; name: string; isShared: boolean; cards: string[]; ownerName: string | null }
  rendered: RenderedCard[]
  /** Every dashboard this person can open, for the switcher under the name. */
  all: SwitchChoice[]
  canEdit: boolean
}

export const DashboardView = ({
  account,
  from,
  to,
  catalogue,
  retired,
  dashboard,
  rendered,
  all,
  canEdit,
}: DashboardViewProps) => {
  const router = useRouter()
  const range = useRangeLabel(from, to)
  const toast = useToast()
  // null is closed. Add content and Dashboard details both edit this dashboard;
  // Create dashboard starts a new one.
  const [editing, setEditing] = useState<'content' | 'details' | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  // The order just dropped, drawn until the refresh that follows the save brings
  // the same order back from the server.
  const [placed, setPlaced] = useState<string[] | null>(null)
  const [drawn, setDrawn] = useState(rendered)
  if (drawn !== rendered) {
    setDrawn(rendered)
    setPlaced(null)
  }
  const byKey = new Map(rendered.map((card) => [card.key, card]))
  const cards = placed ? placed.flatMap((key) => byKey.get(key) ?? []) : rendered

  /** A layout change saves at once, as HubSpot's does. A retired key stays at the
   *  end, so the warning about it is not quietly lost. */
  const relayout = async (keys: string[]) => {
    setPlaced(keys)
    try {
      const kept = new Set(keys)
      await api.reporting.dashboards.save.mutate({
        id: dashboard.id,
        name: dashboard.name,
        isShared: dashboard.isShared,
        cards: [...keys, ...dashboard.cards.filter((key) => !byKey.has(key) && !kept.has(key))],
      })
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
      setPlaced(null)
    }
  }

  /** The dragged card takes the place of the one it is dropped on. O(cards). */
  const drop = (onto: string) => {
    const keys = cards.map((card) => card.key)
    if (!dragging || dragging === onto) return
    const without = keys.filter((key) => key !== dragging)
    without.splice(keys.indexOf(onto), 0, dragging)
    void relayout(without)
  }

  const save = async (input: { name: string; cards: string[]; isShared: boolean }) => {
    setBusy(true)
    try {
      if (editing === 'new') {
        const { id } = await api.reporting.dashboards.save.mutate(input)
        router.push(dashboardPath(account, id, { from, to }))
      } else {
        await api.reporting.dashboards.save.mutate({ id: dashboard.id, ...input })
        router.refresh()
      }
      setEditing(null)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await api.reporting.dashboards.remove.mutate({ id: dashboard.id })
      router.push(reportsPath(account, { tab: 'dashboards', from, to }))
    } catch (cause) {
      toast('error', errorMessage(cause))
      setBusy(false)
    }
  }

  const pill =
    'inline-flex h-pill shrink-0 items-center gap-1 rounded-pill border border-line-strong bg-surface px-4 text-small text-body no-underline transition-all duration-150 ease-out hover:bg-fill'

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* HubSpot's dashboard header: the name is the switcher, and the rule under
          it runs the full width of the page card. */}
      <div className="-mx-3 flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 pb-4 sm:-mx-6 sm:px-6">
        <DashboardSwitcher account={account} from={from} to={to} current={dashboard} all={all} />
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={reportsPath(account, { tab: 'dashboards', from, to })}
            className="inline-flex h-pill items-center rounded-pill px-2 text-small font-semibold text-body no-underline transition-all duration-150 ease-out hover:bg-fill"
          >
            Manage dashboards
          </Link>
          <button type="button" className={pill} onClick={() => setEditing('new')}>
            Create dashboard
          </button>
          {canEdit ? (
            <DropdownMenu
              label="Actions"
              groups={[
                { key: 'edit', items: [{ key: 'details', label: 'Dashboard details', onSelect: () => setEditing('details') }] },
                { key: 'danger', items: [{ key: 'delete', label: 'Delete', destructive: true, onSelect: () => setConfirming(true) }] },
              ]}
              trigger={(props) => (
                <button {...props} type="button" className={cn(pill, 'font-light')}>
                  Actions
                  <ChevronDown aria-hidden="true" className="size-3.5" />
                </button>
              )}
            />
          ) : null}
          <Button variant="primary" disabled={!canEdit} onClick={() => setEditing('content')}>
            Add content
          </Button>
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <RangePicker from={from} to={to} />
      </div>

      <div className="flex min-w-0 flex-col gap-3">
      {retired > 0 ? (
        <Alert tone="warning">
          {retired === 1
            ? 'One card on this dashboard no longer exists and is not drawn.'
            : `${retired} cards on this dashboard no longer exist and are not drawn.`}{' '}
          Open Add content to tidy it up.
        </Alert>
      ) : null}

      {cards.length === 0 ? (
        <EmptyState title="Nothing to draw" description="Every card on this dashboard has been retired." />
      ) : (
        <div className="grid min-w-0 gap-2.5 @2xl:grid-cols-2 @5xl:grid-cols-3">
          {cards.map((card) => (
            <ReportCard
              key={card.key}
              card={card}
              href={reportsPath(account, { tab: card.report, from, to })}
              range={range}
              dragging={dragging === card.key}
              grip={
                canEdit
                  ? {
                      onDragStart: (event) => {
                        setDragging(card.key)
                        event.dataTransfer.effectAllowed = 'move'
                      },
                      onDragEnd: () => setDragging(null),
                    }
                  : null
              }
              target={
                dragging
                  ? {
                      onDragOver: (event) => event.preventDefault(),
                      onDrop: (event) => {
                        event.preventDefault()
                        drop(card.key)
                        setDragging(null)
                      },
                    }
                  : null
              }
              onRemove={
                canEdit && cards.length > 1
                  ? () => void relayout(cards.map((each) => each.key).filter((key) => key !== card.key))
                  : null
              }
            />
          ))}
        </div>
      )}
      </div>

      <CardPicker
        open={editing !== null}
        busy={busy}
        title={editing === 'new' ? 'Create dashboard' : editing === 'details' ? 'Dashboard details' : `Add content to ${dashboard.name}`}
        catalogue={catalogue}
        initial={editing === 'new' ? { name: '', cards: [], isShared: false } : { name: dashboard.name, cards: dashboard.cards, isShared: dashboard.isShared }}
        onClose={() => setEditing(null)}
        onSave={(input) => void save(input)}
      />

      <ConfirmDialog
        open={confirming}
        title={`Delete “${dashboard.name}”?`}
        confirm="Delete"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove()}
      >
        <p>The reports on it stay in the reports list.</p>
      </ConfirmDialog>
    </div>
  )
}
