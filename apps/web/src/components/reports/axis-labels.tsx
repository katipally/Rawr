'use client'

import { cn } from '@rawr/ui'
import { useEffect, useRef, useState } from 'react'
import { tickStride, visibleTicks } from './axis.ts'

/** A bar chart's x axis. Its own component because how many labels fit is a
 *  question about pixels, which only the browser can answer, and the charts
 *  themselves are rendered on the server. */
export const AxisLabels = ({ labels }: { labels: string[] }) => {
  const [width, setWidth] = useState(0)
  const row = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = row.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => setWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const longest = labels.reduce((widest, label) => Math.max(widest, label.length), 0)
  const shown = visibleTicks(labels.length, tickStride(labels.length, longest, width))

  return (
    // One slot per column whether or not it is labelled, so what is drawn stays
    // under the bar it names. A drawn label overflows its own slot rather than
    // truncating; the slots either side of it are empty, which is the whole point
    // of thinning.
    <div ref={row} className="flex min-w-0" aria-hidden="true">
      {labels.map((label, column) => (
        <span
          key={column}
          className={cn(
            'min-w-0 flex-1 whitespace-nowrap px-0.5 text-small text-secondary',
            // The first and last labels are anchored inwards so they stay inside
            // the card instead of half over its edge.
            column === 0 ? 'text-left' : column === labels.length - 1 ? 'text-right' : 'text-center',
          )}
        >
          {shown.has(column) ? label : null}
        </span>
      ))}
    </div>
  )
}
