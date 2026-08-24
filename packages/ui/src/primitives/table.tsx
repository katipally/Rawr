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

export type DataTableProps<Row> = {
  columns: Column<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string
  onRowClick?: (row: Row) => void
  caption: string
  empty?: ReactNode
}

const MIN_WIDTH = 64

export const DataTable = <Row,>({
  columns,
  rows,
  rowKey,
  onRowClick,
  caption,
  empty,
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

  return (
    // The table scrolls inside its own box. The page never scrolls sideways.
    <div className="w-full overflow-x-auto rounded-panel border border-line bg-surface">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-fill">
            {columns.map((column) => {
              const width = widths[column.key] ?? column.width
              return (
                <th
                  key={column.key}
                  scope="col"
                  style={width ? { width, minWidth: width } : undefined}
                  className={cn(
                    'relative border-b border-line px-3 py-2 text-small font-medium text-secondary',
                    'sticky top-0 z-10 bg-fill whitespace-nowrap',
                    column.align === 'right' && 'text-right',
                  )}
                >
                  {column.header}
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${column.header}`}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      startResize(
                        column.key,
                        event.clientX,
                        event.currentTarget.parentElement?.offsetWidth ?? MIN_WIDTH,
                      )
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
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    'h-row px-3 py-1.5 align-middle',
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
