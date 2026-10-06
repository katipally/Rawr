'use client'

import { Alert, Button, Card, ConfirmDialog, cn, DropdownMenu, EmptyState, useToast } from '@rawr/ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { LinkButton } from '~/components/link-button.tsx'
import { RangePicker } from '~/components/reports/range-picker.tsx'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { dashboardPath, reportsPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { CardPicker, type CardChoice } from '../card-picker.tsx'
import { DashboardSwitcher, type SwitchChoice } from './dashboard-switcher.tsx'
import { useFormat } from '~/components/zone.tsx'

type CardData =
  | { kind: 'metric'; value: string; hint: string }
  | { kind: 'table'; columns: string[]; rows: (string | number)[][] }

export type RenderedCard = { key: string; label: string; report: string; data: CardData }

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
  const fmt = useFormat()
  const router = useRouter()
  const toast = useToast()
  // null is closed. Add content and Dashboard details both edit this dashboard;
  // Create dashboard starts a new one.
  const [editing, setEditing] = useState<'content' | 'details' | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

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
          Change the cards to tidy it up.
        </Alert>
      ) : null}

      {rendered.length === 0 ? (
        <EmptyState title="Nothing to draw" description="Every card on this dashboard has been retired." />
      ) : (
        <div className="grid min-w-0 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
          {rendered.map((card) => (
            <Card
              key={card.key}
              title={card.label}
              action={
                <LinkButton
                  href={reportsPath(account, { tab: card.report, from, to })}
                  variant="tertiary"
                  className="shrink-0 gap-1 px-2 py-1"
                  icon={<ChevronRight aria-hidden="true" className="order-1 size-3.5" />}
                >
                  Full report
                </LinkButton>
              }
            >
              {card.data.kind === 'metric' ? (
                <div className="flex flex-col gap-1">
                  <span className="text-lg font-medium tabular-nums">{card.data.value}</span>
                  <span className="text-small text-secondary">{card.data.hint}</span>
                </div>
              ) : card.data.rows.length === 0 ? (
                <p className="text-secondary">Nothing in this range.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="border-b border-divider text-small text-secondary">
                        {card.data.columns.map((column, index) => (
                          <th
                            key={column}
                            className={index === 0 ? 'py-1 pr-2 font-medium' : 'py-1 pr-2 text-right font-medium'}
                          >
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {/* The first cell is a name, and names repeat: two sequences
                          may share one. A report table is positional, so the row
                          number is what identifies a row. */}
                      {card.data.rows.map((row, rowIndex) => (
                        <tr key={rowIndex} className="border-b border-divider last:border-0">
                          {row.map((cell, index) => (
                            <td
                              key={card.data.kind === 'table' ? card.data.columns[index] : index}
                              className={
                                index === 0
                                  ? 'py-1 pr-2 break-words'
                                  : 'py-1 pr-2 text-right tabular-nums'
                              }
                            >
                              {typeof cell === 'number' ? fmt.number(cell) : cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
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
