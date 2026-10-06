'use client'

import { useState } from 'react'
import { AxisLabels } from './axis-labels.tsx'

/** Every value arrives already written out: the chart is drawn wherever its
 *  caller is, and a formatter is a function, which cannot cross from the server
 *  into this component. */
export type PlotSeries = { label: string; color: string; values: number[]; written: string[] }

/** The drawn half of a bar chart, and the only half that moves: HubSpot's hover,
 *  a dark-headed tooltip over the column with every series' value in it and the
 *  other columns dimmed, and the bars growing up from the axis on first paint.
 *
 *  The bars are an SVG stretched to the container, because bars should fill the
 *  width they are given. Everything with text in it is HTML laid over it: a
 *  stretched SVG scales its text with it, which turns a three-column chart into
 *  distorted letterforms. */
export const BarPlot = ({
  title,
  labels,
  series,
  ticks,
  tickLabels,
  totals,
}: {
  title: string
  labels: string[]
  series: PlotSeries[]
  /** The value axis, from 0 up to the top line, which the tallest bar fits under. */
  ticks: number[]
  tickLabels: string[]
  /** Each column's total across the series, when there is more than one. */
  totals: string[] | null
}) => {
  const [active, setActive] = useState<number | null>(null)
  const top = ticks.at(-1) || 1
  const columns = labels.length
  const height = 180
  // A unit grid: one unit per column, so the widths do not depend on the pixel
  // size the container happens to give it.
  const width = Math.max(1, columns) * 100
  // A wide gap when there are few columns: two bars stretched across a whole card
  // read as a block of colour rather than as a comparison.
  const gap = columns <= 3 ? 55 : columns <= 6 ? 35 : 12
  const barWidth = (100 - gap) / Math.max(1, series.length)
  const at = (value: number) => `${(value / top) * 100}%`
  const axisWidth = `${Math.max(1, ...tickLabels.map((label) => label.length)) + 0.5}ch`
  const leftHalf = active !== null && active < columns / 2

  const step = (by: number) => setActive((current) => Math.min(columns - 1, Math.max(0, (current ?? (by > 0 ? -1 : columns)) + by)))

  return (
    <div className="flex min-w-0 gap-2">
      <div aria-hidden="true" className="relative h-48 shrink-0 text-[0.6875rem] leading-none font-light text-body" style={{ width: axisWidth }}>
        {tickLabels.map((label, index) => (
          <span key={ticks[index]} className="absolute right-0 translate-y-1/2" style={{ bottom: at(ticks[index] ?? 0) }}>
            {label}
          </span>
        ))}
      </div>

      <div className="min-w-0 flex-1">
        <div
          tabIndex={0}
          role="slider"
          aria-label={`${title}. Arrow keys move between columns; the same numbers are in the table below.`}
          aria-valuemin={0}
          aria-valuemax={columns}
          aria-valuenow={active === null ? 0 : active + 1}
          aria-valuetext={
            active === null
              ? 'No column chosen'
              : `${labels[active]}: ${series.map((entry) => `${entry.label} ${entry.written[active]}`).join(', ')}`
          }
          className="relative h-48 rounded-hs outline-none focus-visible:ring-2 focus-visible:ring-line-interactive"
          onPointerLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') step(1)
            else if (event.key === 'ArrowLeft') step(-1)
            else if (event.key === 'Escape') setActive(null)
            else return
            event.preventDefault()
          }}
        >
          {ticks.slice(1).map((tick) => (
            <div
              key={tick}
              aria-hidden="true"
              className="absolute inset-x-0 h-px bg-[linear-gradient(to_right,var(--color-chart-grid)_3px,transparent_3px)] bg-[length:4px_1px]"
              style={{ bottom: at(tick) }}
            />
          ))}
          <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-px bg-chart-axis" />

          <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
            {labels.map((_, column) => (
              // A category axis is positional, and the labels are user data: two
              // sequences may share a name. The column number is the identity.
              <g
                key={column}
                className="transition-opacity duration-150 ease-out"
                opacity={active !== null && active !== column ? 0.2 : 1}
              >
                {series.map((entry, index) => {
                  const value = entry.values[column] ?? 0
                  const barHeight = value === 0 ? 0 : Math.max(2, (value / top) * height)
                  return (
                    <rect
                      key={entry.label}
                      x={column * 100 + gap / 2 + index * barWidth}
                      y={height - barHeight}
                      width={Math.max(1, barWidth - 2)}
                      height={barHeight}
                      fill={entry.color}
                      className="origin-bottom animate-grow-up [transform-box:fill-box] motion-reduce:animate-none"
                    />
                  )
                })}
              </g>
            ))}
          </svg>

          <div className="absolute inset-0 flex">
            {labels.map((_, column) => (
              <div key={column} className="h-full min-w-0 flex-1" onPointerEnter={() => setActive(column)} />
            ))}
          </div>

          {active !== null ? (
            <div
              role="tooltip"
              className="pointer-events-none absolute top-0 z-10 w-max max-w-[min(20rem,50%)] break-words shadow-panel"
              // Beside the column rather than over it, on whichever side has room.
              style={leftHalf ? { left: `${((active + 1) / columns) * 100}%` } : { right: `${100 - (active / columns) * 100}%` }}
            >
              <p className="rounded-t-hs bg-tooltip p-2 font-semibold text-inverse">{labels[active]}</p>
              <ul className="flex flex-col gap-0.5 rounded-b-hs bg-surface p-2 text-small font-light">
                {series.map((entry) => (
                  <li key={entry.label} className="flex min-w-0 items-center gap-2">
                    <span aria-hidden="true" className="size-2 shrink-0 rounded-pill" style={{ background: entry.color }} />
                    <span className="min-w-0 flex-1">{entry.label}</span>
                    <span className="shrink-0 tabular-nums">{entry.written[active]}</span>
                  </li>
                ))}
                {totals ? (
                  <li className="flex min-w-0 gap-2 border-t border-divider pt-0.5">
                    <span className="min-w-0 flex-1">Totals:</span>
                    <span className="shrink-0 tabular-nums">{totals[active]}</span>
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </div>

        <AxisLabels labels={labels} />
      </div>
    </div>
  )
}
