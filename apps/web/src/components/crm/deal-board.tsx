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
  /** Which field a column stands for. A drop writes that field, so a board grouped
   *  by deal type moves the deal's type rather than its stage. */
  groupByKey: string
  canWrite: boolean
}

export const DealBoard = ({ workspace, columns, groupByKey, canWrite }: DealBoardProps) => {
  const router = useRouter()
  const toast = useToast()
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [moving, setMoving] = useState<string | null>(null)

  const move = async (dealId: string, columnKey: string) => {
    setMoving(dealId)
    try {
      await api.crm.board.moveCard.mutate({ dealId, field: groupByKey, value: columnKey })
      toast(
        'success',
        groupByKey === 'stage_id'
          ? 'Stage changed. The move is on the deal timeline.'
          : 'Moved. The change is in the audit log.',
      )
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
        title="This board has no columns"
        description={
          groupByKey === 'stage_id'
            ? 'This pipeline has no stages. An admin adds them in Settings, under Pipelines.'
            : 'The field this board groups by has no values to lay out. An admin adds them in Settings, under Properties.'
        }
      />
    )
  }

  return (
    // The board scrolls inside its own box; the page never scrolls sideways.
    <div className="w-full overflow-x-auto pb-2">
      {/* Stretch, not start: a column that sizes to its own cards leaves an empty
          stage as a header-high drop target, which is the one stage somebody most
          often drags into. Equal heights also stop the board reading as ragged. */}
      <div className="flex min-w-max items-stretch gap-3">
        {columns.map((column) => (
          // A drop target. Dragging is the pointer shortcut, not the only way: the
          // same stage change is on the record page and in bulk edit, both
          // ordinary keyboard-reachable controls. No ARIA role describes a drop
          // zone, so there is nothing truer to put here.
          // biome-ignore lint/a11y/noStaticElementInteractions: see above
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
              // One comfortable reading width, whatever the column count. Growing
              // to fill made a three-column board stretch each card to 470px.
              'flex w-[min(18rem,85vw)] shrink-0 flex-col rounded-panel border bg-fill',
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

            {/* The card list scrolls, the board does not. Height follows the
                viewport rather than a fixed pixel count so a short laptop screen
                and a tall monitor both show whole cards. */}
            <ol className="flex max-h-[min(65svh,50rem)] flex-col gap-2 overflow-y-auto p-2">
              {column.cards.length === 0 ? (
                <li className="px-1 py-2 text-secondary">
                  Nothing {groupByKey === 'stage_id' ? 'in this stage' : 'here'} yet.
                </li>
              ) : (
                column.cards.map((card) => (
                  <li key={card.id}>
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: the drag
                        source for the drop target above, and the same reasoning
                        applies. The card's own link is what a keyboard uses. */}
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
