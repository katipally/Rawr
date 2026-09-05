'use client'

import { Alert, Badge, Button, Card, EmptyState, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { reportsPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { CardPicker, type CardChoice } from '../card-picker.tsx'

type CardData =
  | { kind: 'metric'; value: string; hint: string }
  | { kind: 'table'; columns: string[]; rows: (string | number)[][] }

export type RenderedCard = { key: string; label: string; report: string; data: CardData }

export type DashboardViewProps = {
  workspace: string
  from: string
  to: string
  catalogue: CardChoice[]
  retired: number
  dashboard: { id: string; name: string; isShared: boolean; cards: string[]; ownerName: string | null }
  rendered: RenderedCard[]
  canEdit: boolean
}

export const DashboardView = ({
  workspace,
  from,
  to,
  catalogue,
  retired,
  dashboard,
  rendered,
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
      router.push(reportsPath(workspace, { tab: 'dashboards', from, to }))
    } catch (cause) {
      toast('error', errorMessage(cause))
      setBusy(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={reportsPath(workspace, { tab: 'dashboards', from, to })}
          className="text-sm font-semibold text-link"
        >
          Dashboards
        </Link>
        <span className="text-secondary">/</span>
        <h2 className="font-medium">{dashboard.name}</h2>
        {dashboard.isShared ? <Badge tone="info">Shared</Badge> : <Badge tone="neutral">Private</Badge>}
        {canEdit ? (
          <div className="ml-auto flex gap-2">
            <Button onClick={() => setEditing(true)}>Change cards</Button>
            {confirming ? (
              <>
                <Button variant="destructive" busy={busy} onClick={() => void remove()}>
                  Delete for good
                </Button>
                <Button onClick={() => setConfirming(false)}>Keep it</Button>
              </>
            ) : (
              <Button variant="tertiary" onClick={() => setConfirming(true)}>
                Delete
              </Button>
            )}
          </div>
        ) : null}
      </div>

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
                <Link
                  href={reportsPath(workspace, { tab: card.report, from, to })}
                  className="text-small text-link"
                >
                  Full report
                </Link>
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
                      {card.data.rows.map((row) => (
                        <tr key={String(row[0])} className="border-b border-divider last:border-0">
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
