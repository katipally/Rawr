'use client'

import { EmptyState, cn, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatCurrency, formatDate, isPast } from './value.tsx'

export type BoardCard = {
  id: string
  displayName: string
  amount: string | null
  currency: string
  closeDate: string | null
  ownerName: string | null
  companyName: string | null
  nextStep: string | null
  nextStepDate: string | null
}

export type BoardColumn = {
  key: string
  name: string
  probability: number | null
  count: number
  totals: { currency: string; total: string; weighted: string }[]
  cards: BoardCard[]
  hasMore: boolean
}

/** Our own type, so a file or a link dragged onto the board is ignored rather than
 *  read as a deal id. */
const DRAG_TYPE = 'application/x-rawr-deal'

export type DealBoardProps = {
  workspace: string
  columns: BoardColumn[]
  canWrite: boolean
}

export const DealBoard = ({ workspace, columns, canWrite }: DealBoardProps) => {
  const router = useRouter()
  const toast = useToast()
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [moving, setMoving] = useState<string | null>(null)

  const move = async (dealId: string, stageId: string) => {
    setMoving(dealId)
    try {
      await api.crm.board.moveCard.mutate({ dealId, stageId })
      toast('success', 'Stage changed. The move is on the deal timeline.')
      router.refresh()
    } catch (cause) {
      // The card snaps back because the server never accepted the move.
      toast('error', errorMessage(cause))
    } finally {
      setMoving(null)
      setDragging(null)
      setOver(null)
    }
  }

  if (columns.length === 0) {
    return (
      <EmptyState
        title="This pipeline has no stages"
        description="An admin adds stages in settings. Until then there is nothing to lay a board out on."
      />
    )
  }

  return (
    // The board scrolls inside its own box; the page never scrolls sideways.
    <div className="w-full overflow-x-auto pb-2">
      <div className="flex min-w-max items-start gap-3">
        {columns.map((column) => (
          <section
            key={column.key}
            onDragOver={(event) => {
              if (!canWrite) return
              event.preventDefault()
              setOver(column.key)
            }}
            onDragLeave={() => setOver((current) => (current === column.key ? null : current))}
            onDrop={(event) => {
              event.preventDefault()
              if (!canWrite) return
              // The id travels in the drag itself rather than in React state, so a
              // drop cannot be lost to a render that has not flushed yet.
              const dealId = event.dataTransfer.getData(DRAG_TYPE) || dragging
              if (dealId) void move(dealId, column.key)
            }}
            className={cn(
              'flex w-72 shrink-0 flex-col rounded-panel border bg-fill',
              over === column.key ? 'border-line-interactive bg-accent-subtle' : 'border-line',
            )}
          >
            <header className="border-b border-divider px-3 py-2">
              <p className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate font-medium" title={column.name}>
                  {column.name}
                </span>
                <span className="text-secondary tabular-nums">{column.count}</span>
              </p>
              {column.totals.length === 0 ? (
                <p className="text-small text-secondary">No amounts</p>
              ) : (
                column.totals.map((total) => (
                  <p key={total.currency} className="text-small text-secondary tabular-nums">
                    {formatCurrency(total.total, total.currency)}
                    {column.probability !== null ? (
                      <>
                        {' · '}
                        {formatCurrency(total.weighted, total.currency)} weighted at {column.probability}%
                      </>
                    ) : null}
                  </p>
                ))
              )}
            </header>

            <ol className="flex max-h-[65vh] flex-col gap-2 overflow-y-auto p-2">
              {column.cards.length === 0 ? (
                <li className="px-1 py-2 text-secondary">Nothing in this stage.</li>
              ) : (
                column.cards.map((card) => (
                  <li key={card.id}>
                    <div
                      draggable={canWrite}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(DRAG_TYPE, card.id)
                        event.dataTransfer.effectAllowed = 'move'
                        setDragging(card.id)
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setOver(null)
                      }}
                      aria-busy={moving === card.id || undefined}
                      className={cn(
                        'rounded-hs border border-line bg-surface p-2 shadow-panel',
                        canWrite && 'cursor-grab active:cursor-grabbing',
                        moving === card.id && 'opacity-60',
                        dragging === card.id && 'opacity-40',
                      )}
                    >
                      <Link href={recordPath(workspace, 'deal', card.id)} className="block break-words font-medium">
                        {card.displayName}
                      </Link>
                      {card.companyName ? (
                        <p className="truncate text-secondary" title={card.companyName}>
                          {card.companyName}
                        </p>
                      ) : null}
                      <p className="flex flex-wrap justify-between gap-x-2 tabular-nums">
                        <span>{card.amount === null ? '—' : formatCurrency(card.amount, card.currency)}</span>
                        <span className="text-secondary">{formatDate(card.closeDate) || 'No close date'}</span>
                      </p>
                      {card.nextStep ? (
                        <p className="mt-1 break-words text-small text-secondary">
                          <span className={cn(isPast(card.nextStepDate) && 'font-medium text-error')}>
                            {card.nextStepDate ? `${formatDate(card.nextStepDate)}: ` : ''}
                          </span>
                          {card.nextStep}
                        </p>
                      ) : null}
                      {card.ownerName ? (
                        <p className="mt-1 truncate text-small text-secondary">{card.ownerName}</p>
                      ) : null}
                    </div>
                  </li>
                ))
              )}

              {column.hasMore ? (
                <li className="px-1 py-1 text-small text-secondary">
                  Showing {column.cards.length} of {column.count}. Narrow the filters to see the rest.
                </li>
              ) : null}
            </ol>
          </section>
        ))}
      </div>
    </div>
  )
}
