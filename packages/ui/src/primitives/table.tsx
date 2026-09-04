'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
  /** Remembers this table's column widths in the browser. Sorting is a navigation,
   *  so without it every resize is undone by the next click on a column. */
  storageKey?: string
  /** Fills the remaining height of a flex column and scrolls inside itself, which
   *  is what makes the header stick. Needs every ancestor up to the shell's <main>
   *  to be a flex column with min-h-0; without that the box collapses, so it is
   *  opt-in rather than the default. */
  fill?: boolean
}

const MIN_WIDTH = 64
const DEFAULT_WIDTH = 180
const SELECT_WIDTH = 40
const KEY_STEP = 16

const readWidths = (storageKey: string | undefined): Record<string, number> => {
  if (!storageKey) return {}
  try {
    const raw = window.localStorage.getItem(`rawr.widths.${storageKey}`)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    // Private windows and blocked site data are normal, not an error.
    return {}
  }
}

export const DataTable = <Row,>({
  columns,
  rows,
  rowKey,
  onRowClick,
  caption,
  empty,
  selection,
  storageKey,
  fill = false,
}: DataTableProps<Row>) => {
  const [widths, setWidths] = useState<Record<string, number>>({})
  const drag = useRef<{ key: string; startX: number; startWidth: number } | null>(null)
  /** What a pointermove handler outside React's render can read without going
   *  stale, and what the end of a drag writes to storage. */
  const latest = useRef(widths)
  latest.current = widths

  // Read after mount, never during render: the server has no localStorage and a
  // width read at render time would not match the markup it hydrates against.
  useEffect(() => setWidths(readWidths(storageKey)), [storageKey])

  const save = useCallback(
    (next: Record<string, number>) => {
      if (!storageKey) return
      try {
        window.localStorage.setItem(`rawr.widths.${storageKey}`, JSON.stringify(next))
      } catch {
        // The resize still holds for this page view.
      }
    },
    [storageKey],
  )

  const onPointerMove = useCallback((event: PointerEvent) => {
    const current = drag.current
    if (!current) return
    const next = Math.max(MIN_WIDTH, current.startWidth + (event.clientX - current.startX))
    setWidths((w) => ({ ...w, [current.key]: next }))
  }, [])

  const stop = useCallback(() => {
    if (!drag.current) return
    drag.current = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', stop)
    save(latest.current)
  }, [onPointerMove, save])

  // A drag still live when the table unmounts would otherwise leave two window
  // listeners behind for the rest of the session.
  useEffect(() => stop, [stop])

  if (rows.length === 0 && empty) return <>{empty}</>

  const widthOf = (column: Column<Row>): number =>
    widths[column.key] ?? column.width ?? DEFAULT_WIDTH

  const startResize = (key: string, startX: number, startWidth: number) => {
    drag.current = { key, startX, startWidth }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stop)
  }

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
    // A box with overflow-x:auto has its other axis forced to a scroll container
    // whatever is asked for, so `sticky` on a header always resolves against this
    // box and never against the page. The header therefore only sticks when this
    // box is the thing that scrolls, which is what `fill` arranges.
    <div
      className={cn(
        'w-full overflow-auto rounded-panel border border-line bg-surface',
        fill && 'min-h-0 flex-1',
      )}
    >
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
          <tr>
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
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'relative sticky top-0 z-10 border-b border-line px-3 py-2',
                  'truncate bg-fill text-small font-medium text-secondary',
                  column.align === 'right' && 'text-right',
                )}
                title={column.header}
              >
                {column.header}
                {/* Focusable and driven by the arrow keys, because a pointer is
                    not the only way somebody arrives at this table. */}
                {/* biome-ignore lint/a11y/useSemanticElements: there is no HTML
                    element for a column resize handle. A focusable separator
                    carrying aria-valuenow is the widget ARIA defines for it, and
                    <hr>, the rule's suggestion, cannot hold the behaviour. */}
                <span
                  role="separator"
                  tabIndex={0}
                  aria-orientation="vertical"
                  aria-label={`Resize ${column.header}`}
                  aria-valuenow={widthOf(column)}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    startResize(column.key, event.clientX, widthOf(column))
                  }}
                  onKeyDown={(event) => {
                    const step =
                      event.key === 'ArrowRight' ? KEY_STEP : event.key === 'ArrowLeft' ? -KEY_STEP : 0
                    if (step === 0) return
                    event.preventDefault()
                    const next = { ...widths, [column.key]: Math.max(MIN_WIDTH, widthOf(column) + step) }
                    setWidths(next)
                    save(next)
                  }}
                  className="absolute top-0 right-0 h-full w-1 cursor-col-resize touch-none hover:bg-line-interactive focus-visible:bg-line-interactive"
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            // The row's first cell already renders a real link to the same
            // destination, so every row is reachable and announced without this
            // handler. Giving the <tr> its own tab stop would put two on every row
            // and make keyboard use of a long list worse, not better.
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                'border-b border-divider last:border-0',
                onRowClick && 'cursor-pointer hover:bg-fill-hover',
                selection?.selected.has(rowKey(row)) && 'bg-accent-subtle',
              )}
            >
              {selection ? (
                // Not a control. The handler only stops a tick on the checkbox from
                // also opening the row; the checkbox inside is what is operated,
                // and it is an ordinary keyboard-reachable input.
                // biome-ignore lint/a11y/useKeyWithClickEvents: see above
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
