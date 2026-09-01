'use client'

import { useCallback, useRef, useState, type ReactNode } from 'react'
import { cn } from '../cn.ts'

export type Column<Row> = {
  key: string
  header: string
  /** Starting width in pixels. Resizing is per-column and never collapses to zero. */
  width?: number
  align?: 'left' | 'right'
  render: (row: Row) => ReactNode
}

export type Selection = {
  /** Ids currently ticked. Held by the caller so a page change can keep or drop it. */
  selected: ReadonlySet<string>
  onChange: (next: Set<string>) => void
  /** What one row is called in the select-all label, e.g. "contact". */
  noun: string
}

export type DataTableProps<Row> = {
  columns: Column<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string
  onRowClick?: (row: Row) => void
  caption: string
  empty?: ReactNode
  /** Omitted means no checkbox column at all, which is what a read-only table wants. */
  selection?: Selection
}

const MIN_WIDTH = 64
const DEFAULT_WIDTH = 180
const SELECT_WIDTH = 40

export const DataTable = <Row,>({
  columns,
  rows,
  rowKey,
  onRowClick,
  caption,
  empty,
  selection,
}: DataTableProps<Row>) => {
  const [widths, setWidths] = useState<Record<string, number>>({})
  const drag = useRef<{ key: string; startX: number; startWidth: number } | null>(null)

  const onPointerMove = useCallback((event: PointerEvent) => {
    const current = drag.current
    if (!current) return
    const next = Math.max(MIN_WIDTH, current.startWidth + (event.clientX - current.startX))
    setWidths((w) => ({ ...w, [current.key]: next }))
  }, [])

  const stop = useCallback(() => {
    drag.current = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', stop)
  }, [onPointerMove])

  const startResize = (key: string, startX: number, startWidth: number) => {
    drag.current = { key, startX, startWidth }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stop)
  }

  if (rows.length === 0 && empty) return <>{empty}</>

  const widthOf = (column: Column<Row>): number =>
    widths[column.key] ?? column.width ?? DEFAULT_WIDTH

  const allTicked =
    selection !== undefined && rows.length > 0 && rows.every((row) => selection.selected.has(rowKey(row)))

  const toggleAll = () => {
    if (!selection) return
    const next = new Set(selection.selected)
    for (const row of rows) {
      if (allTicked) next.delete(rowKey(row))
      else next.add(rowKey(row))
    }
    selection.onChange(next)
  }

  const toggleOne = (id: string) => {
    if (!selection) return
    const next = new Set(selection.selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selection.onChange(next)
  }

  return (
    // The table scrolls inside its own box. The page never scrolls sideways.
    <div className="w-full overflow-x-auto rounded-panel border border-line bg-surface">
      {/*  table-layout: fixed is what makes truncation possible at all. In the
           default auto layout a cell grows to fit its content however narrow the
           header says it is, so a 500-character name stretches its column past
           17,000px and pushes every other column off the screen. Fixed layout
           makes the colgroup authoritative and the per-cell `truncate` real. */}
      <table className="w-full table-fixed border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          {selection ? <col style={{ width: SELECT_WIDTH }} /> : null}
          {columns.map((column) => (
            <col key={column.key} style={{ width: widthOf(column) }} />
          ))}
        </colgroup>
        <thead>
          <tr className="bg-fill">
            {selection ? (
              <th
                scope="col"
                className="sticky top-0 z-10 border-b border-line bg-fill px-3 py-2"
              >
                <input
                  type="checkbox"
                  checked={allTicked}
                  onChange={toggleAll}
                  aria-label={`Select every ${selection.noun} on this page`}
                />
              </th>
            ) : null}
            {columns.map((column) => {
              return (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    'relative border-b border-line px-3 py-2 font-medium',
                    'sticky top-0 z-10 truncate bg-fill text-small text-secondary',
                    column.align === 'right' && 'text-right',
                  )}
                  title={column.header}
                >
                  {column.header}
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${column.header}`}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      startResize(column.key, event.clientX, widthOf(column))
                    }}
                    className="absolute top-0 right-0 h-full w-1 cursor-col-resize touch-none hover:bg-line-interactive"
                  />
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                'border-b border-divider last:border-0',
                onRowClick && 'cursor-pointer hover:bg-fill',
                selection?.selected.has(rowKey(row)) && 'bg-accent-subtle',
              )}
            >
              {selection ? (
                <td className="h-row px-3 py-1.5 align-middle" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selection.selected.has(rowKey(row))}
                    onChange={() => toggleOne(rowKey(row))}
                    aria-label={`Select this ${selection.noun}`}
                  />
                </td>
              ) : null}
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    'h-row overflow-hidden px-3 py-1.5 align-middle',
                    column.align === 'right' && 'text-right tabular-nums',
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
