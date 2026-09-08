'use client'

import { Alert, Badge, Button, Card, DropdownMenu, EmptyState, useToast } from '@rawr/ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { LinkButton } from '~/components/link-button.tsx'
import { RangePicker } from '~/components/reports/range-picker.tsx'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { dashboardPath, reportsPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { CardPicker, type CardChoice } from '../card-picker.tsx'

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
  /** Every dashboard this person can open, for the picker beside the name. */
  all: { id: string; name: string }[]
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
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const save = async (input: { name: string; cards: string[]; isShared: boolean }) => {
    setBusy(true)
    try {
      await api.reporting.dashboards.save.mutate({ id: dashboard.id, ...input })
      setEditing(false)
      router.refresh()
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
    'inline-flex h-control items-center gap-1 rounded-pill border border-line-strong bg-surface px-4 text-small font-light text-body no-underline hover:bg-fill'

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* HubSpot's dashboard header: the name is a picker across every dashboard,
          and the actions sit at the right of a white strip over the canvas. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-6 py-4">
        <DropdownMenu
          label="Switch dashboard"
          align="start"
          groups={[
            {
              key: 'dashboards',
              items: all.map((row) => ({
                key: row.id,
                label: row.name,
                href: dashboardPath(account, row.id, { from, to }),
                checked: row.id === dashboard.id,
              })),
            },
          ]}
          trigger={(props) => (
            <button {...props} type="button" className="flex min-w-0 items-center gap-2 rounded-hs text-xl font-normal hover:bg-fill">
              <h1 className="min-w-0 truncate">{dashboard.name}</h1>
              {dashboard.isShared ? <Badge tone="info">Shared</Badge> : <Badge tone="neutral">Private</Badge>}
              <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
            </button>
          )}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Link href={reportsPath(account, { tab: 'dashboards', from, to })} className="px-2 font-semibold">
            Manage dashboards
          </Link>
          {canEdit ? (
            confirming ? (
              <>
                <Button variant="destructive" busy={busy} onClick={() => void remove()}>
                  Delete for good
                </Button>
                <Button onClick={() => setConfirming(false)}>Keep it</Button>
              </>
            ) : (
              <DropdownMenu
                label="Actions"
                groups={[
                  { key: 'edit', items: [{ key: 'cards', label: 'Change cards', onSelect: () => setEditing(true) }] },
                  { key: 'danger', items: [{ key: 'delete', label: 'Delete dashboard', destructive: true, onSelect: () => setConfirming(true) }] },
                ]}
                trigger={(props) => (
                  <button {...props} type="button" className={pill}>
                    Actions
                    <ChevronDown aria-hidden="true" className="size-3.5" />
                  </button>
                )}
              />
            )
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6">
        <RangePicker from={from} to={to} />
      </div>

      <div className="flex min-w-0 flex-col gap-3 px-6 pb-6">
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
                              {typeof cell === 'number' ? cell.toLocaleString() : cell}
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
        open={editing}
        busy={busy}
        title={`Cards on ${dashboard.name}`}
        catalogue={catalogue}
        initial={{ name: dashboard.name, cards: dashboard.cards, isShared: dashboard.isShared }}
        onClose={() => setEditing(false)}
        onSave={save}
      />
    </div>
  )
}
