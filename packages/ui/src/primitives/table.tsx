'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../cn.ts'
import { Checkbox } from './choice.tsx'
import { layoutWidths, MIN_WIDTH, parseWidths, widthsKey } from './table-widths.ts'

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

const SELECT_WIDTH = 45
const KEY_STEP = 16

const readWidths = (storageKey: string | undefined): Record<string, number> => {
  if (!storageKey) return {}
  try {
    return parseWidths(window.localStorage.getItem(widthsKey(storageKey)))
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
  /** The scroll box's content width. 0 until measured, and re-measured on every
   *  resize, so a window dragged narrower mid-drag re-fits rather than clipping. */
  const [available, setAvailable] = useState(0)
  const [atEnd, setAtEnd] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ key: string; startX: number; startWidth: number } | null>(null)
  /** What a pointermove handler outside React's render can read without going
   *  stale, and what the end of a drag writes to storage. */
  const latest = useRef(widths)
  latest.current = widths

  const select = selection ? SELECT_WIDTH : 0
  const rendered = layoutWidths(widths, columns, available > 0 ? available - select : 0)
  const widthOf = (index: number): number => rendered[index] ?? MIN_WIDTH
  const total = select + rendered.reduce((sum, width) => sum + width, 0)
  const overflowing = available > 0 && total > available

  // Read after mount, never during render: the server has no localStorage and a
  // width read at render time would not match the markup it hydrates against.
  useEffect(() => setWidths(readWidths(storageKey)), [storageKey])

  // `total` is the trigger rather than something the body reads: re-running on
  // every change to the table's own width is what catches a column added, a
  // stored width restored, or a drag that has just made the table overflow.
  // Setting `available` to a width it already holds is what ends the cycle.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const element = box.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      setAvailable(element.clientWidth)
      setAtEnd(element.scrollLeft + element.clientWidth >= element.scrollWidth - 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [total])

  const save = useCallback(
    (next: Record<string, number>) => {
      if (!storageKey) return
      try {
        window.localStorage.setItem(widthsKey(storageKey), JSON.stringify(next))
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
    <div className={cn('relative w-full', fill && 'flex min-h-0 flex-1 flex-col')}>
      {/* A box with overflow-x:auto has its other axis forced to a scroll container
          whatever is asked for, so `sticky` on a header always resolves against
          this box and never against the page. The header therefore only sticks
          when this box is the thing that scrolls, which is what `fill` arranges. */}
      <div
        ref={box}
        onScroll={(event) => {
          const { scrollLeft, scrollWidth, clientWidth } = event.currentTarget
          setAtEnd(scrollLeft + clientWidth >= scrollWidth - 1)
        }}
        className={cn(
          'w-full overflow-auto border-t border-line bg-surface',
          fill && 'min-h-0 flex-1',
        )}
      >
        {/*  table-layout: fixed is what makes truncation possible at all. In the
             default auto layout a cell grows to fit its content however narrow the
             header says it is, so a 500-character name stretches its column past
             17,000px and pushes every other column off the screen. Fixed layout
             makes the colgroup authoritative and the per-cell `truncate` real. */}
        {/*  The table is exactly as wide as its columns add up to, so fixed layout
             has no slack to redistribute: every column renders at the width the
             layout gave it and a resize handle follows the pointer. Until the box
             has been measured the table is simply full width, which is close enough
             to the fitted result that the first paint does not jump. */}
        <table
          className="table-fixed border-collapse text-left"
          style={available > 0 ? { width: total, minWidth: total } : { width: '100%' }}
        >
          <caption className="sr-only">{caption}</caption>
          {/*  See layoutWidths: a dragged column keeps its stored width, the rest
               share what is left of the box. */}
          <colgroup>
            {selection ? <col style={{ width: SELECT_WIDTH }} /> : null}
            {columns.map((column, index) => (
              <col key={column.key} style={{ width: widthOf(index) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {selection ? (
                <th
                  scope="col"
                  className="sticky top-0 z-10 h-row border-b border-line bg-surface px-3 align-middle"
                >
                  <Checkbox
                    hideLabel
                    checked={allTicked}
                    onChange={toggleAll}
                    label={`Select every ${selection.noun} on this page`}
                  />
                </th>
              ) : null}
              {columns.map((column, index) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    'relative sticky top-0 z-10 h-row border-b border-line px-6 align-middle',
                    'truncate bg-surface font-normal text-secondary',
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
                    aria-valuenow={widthOf(index)}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      startResize(column.key, event.clientX, widthOf(index))
                    }}
                    onKeyDown={(event) => {
                      const step =
                        event.key === 'ArrowRight' ? KEY_STEP : event.key === 'ArrowLeft' ? -KEY_STEP : 0
                      if (step === 0) return
                      event.preventDefault()
                      const next = { ...widths, [column.key]: Math.max(MIN_WIDTH, widthOf(index) + step) }
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
                  'border-b border-line',
                  onRowClick && 'cursor-pointer hover:bg-fill',
                  selection?.selected.has(rowKey(row)) && 'bg-accent-subtle',
                )}
              >
                {selection ? (
                  // Not a control. The handler only stops a tick on the checkbox from
                  // also opening the row; the checkbox inside is what is operated,
                  // and it is an ordinary keyboard-reachable input.
                  // biome-ignore lint/a11y/useKeyWithClickEvents: see above
                  <td className="h-row px-3 py-0.5 align-middle" onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      hideLabel
                      checked={selection.selected.has(rowKey(row))}
                      onChange={() => toggleOne(rowKey(row))}
                      label={`Select this ${selection.noun}`}
                    />
                  </td>
                ) : null}
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      'h-row overflow-hidden px-6 py-0.5 align-middle',
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
      {/* macOS hides overlay scrollbars until something scrolls, so a clipped
          actions column looks like the end of the table. This edge is the
          affordance; it goes as soon as the last column is in view. */}
      {overflowing && !atEnd ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-scrim/20 to-transparent"
        />
      ) : null}
    </div>
  )
}
