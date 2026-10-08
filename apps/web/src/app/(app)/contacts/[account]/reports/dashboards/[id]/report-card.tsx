'use client'

import { cn, DropdownMenu } from '@rawr/ui'
import { GripVertical, MoreVertical } from 'lucide-react'
import Link from 'next/link'
import type { DragEvent } from 'react'
import { useFormat } from '~/components/zone.tsx'

type CardData =
  | { kind: 'metric'; value: string; hint: string }
  | { kind: 'table'; columns: string[]; rows: (string | number)[][] }

export type RenderedCard = { key: string; label: string; report: string; data: CardData }

/** Shown while the pointer is over the card or something in it has focus, and
 *  always where there is no hover to show it with. */
const onHover = 'opacity-0 transition-opacity duration-150 ease-out group-hover/card:opacity-100 group-focus-within/card:opacity-100 [@media(hover:none)]:opacity-100'

/** One report on a dashboard, in HubSpot's tile: the name as a link into the
 *  report it comes from, the range it covers as a tag, a grip to drag it by, and
 *  the More actions menu, which shows on hover. */
export const ReportCard = ({
  card,
  href,
  range,
  grip,
  dragging,
  target,
  onRemove,
}: {
  card: RenderedCard
  href: string
  range: string
  /** The drag handle's own events, or null when this person cannot rearrange. */
  grip: { onDragStart: (event: DragEvent) => void; onDragEnd: () => void } | null
  dragging: boolean
  /** Where a dragged card would land, or null when nothing is being dragged. */
  target: { onDragOver: (event: DragEvent) => void; onDrop: (event: DragEvent) => void } | null
  /** Takes it off the dashboard, or null when that is not this person's to do
   *  or it is the last card left. */
  onRemove: (() => void) | null
}) => {
  const fmt = useFormat()
  const { data } = card

  return (
    <section
      aria-label={card.label}
      onDragOver={target?.onDragOver}
      onDrop={target?.onDrop}
      className={cn(
        'group/card relative flex min-w-0 flex-col gap-3 rounded-panel border border-line bg-surface p-3 transition-all duration-150 ease-out hover:border-line-strong hover:shadow-side motion-reduce:transition-none',
        dragging && 'opacity-60',
      )}
    >
      <header className="flex min-w-0 items-start gap-1">
        {grip ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: the grip is the pointer's shortcut; the order is also set in Add content
          <span
            draggable
            onDragStart={grip.onDragStart}
            onDragEnd={grip.onDragEnd}
            title="Drag to move"
            className="-ml-1.5 flex size-6 shrink-0 cursor-grab items-center justify-center text-secondary"
          >
            <GripVertical aria-hidden="true" className="size-3.5" />
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <Link href={href} className="max-w-full break-words text-base font-semibold">
            {card.label}
          </Link>
          <span className="inline-flex min-h-5 max-w-full items-center rounded-pill bg-canvas px-[7px] text-[0.625rem] font-semibold">
            {range}
          </span>
        </div>
        <DropdownMenu
          label={`More actions for ${card.label}`}
          groups={[
            { key: 'go', items: [{ key: 'report', label: 'Go to report', href }] },
            ...(onRemove ? [{ key: 'remove', items: [{ key: 'remove', label: 'Remove from dashboard', onSelect: onRemove }] }] : []),
          ]}
          trigger={(props) => (
            <button
              {...props}
              type="button"
              aria-label={`More actions for ${card.label}`}
              className={cn('flex size-6 shrink-0 items-center justify-center rounded-pill text-body hover:bg-fill', onHover)}
            >
              <MoreVertical aria-hidden="true" className="size-4" />
            </button>
          )}
        />
      </header>

      {data.kind === 'metric' ? (
        <div className="flex flex-col items-center gap-1 py-4 text-center">
          <span className="max-w-full break-words text-kpi font-semibold text-link tabular-nums">{data.value}</span>
          <span className="text-small text-secondary">{data.hint}</span>
        </div>
      ) : data.rows.length === 0 ? (
        <p className="py-6 text-center">There is no data to show in this time frame. Try changing the date range.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-divider text-small text-secondary">
                {data.columns.map((column, index) => (
                  <th key={column} className={index === 0 ? 'py-1 pr-2 font-medium' : 'py-1 pr-2 text-right font-medium'}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* The first cell is a name, and names repeat: two sequences may
                  share one. A report table is positional, so the row number is
                  what identifies a row. */}
              {data.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-divider last:border-0">
                  {row.map((cell, index) => (
                    <td
                      key={data.columns[index] ?? index}
                      className={index === 0 ? 'py-1 pr-2 break-words' : 'py-1 pr-2 text-right tabular-nums'}
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
    </section>
  )
}
