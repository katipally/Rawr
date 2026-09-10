'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { encodeFilters, objectView, type ListParams } from '~/lib/links.ts'
import { api } from '~/lib/rpc.ts'
import type { Group } from './filter-builder.tsx'

type Kpi = { key: string; label: string; count: number; filters: Group[] }

export type KpiStripProps = {
  account: string
  object: string
  view: string
  /** The address the tiles link back to, so a filtered, sorted, searched list
   *  stays filtered, sorted and searched with one more filter on it. */
  params: ListParams
  /** What the screen is already filtered by. A tile narrows that rather than
   *  replacing it, which is what makes the strip usable twice. */
  filters: Group[]
  /** False when the list holds nothing at all. Four counts of nothing is four
   *  zeroes and a row of noise above an empty state. */
  hasRecords: boolean
}

/** The row of counts above a list: what is missing from these records, and one
 *  click to see which ones.
 *
 *  Its own round trip rather than part of the page, because four counts over
 *  eighty-eight thousand contacts is one table scan and the rows should not wait
 *  for it. Nothing is rendered until it answers, and nothing is rendered if it
 *  fails: a broken count is not worth an error above somebody's list. */
export const KpiStrip = ({ account, object, view, params, filters, hasRecords }: KpiStripProps) => {
  const [tiles, setTiles] = useState<Kpi[] | null>(null)

  useEffect(() => {
    if (!hasRecords) return
    let live = true
    api.crm.kpis
      .query({ object })
      .then((rows) => {
        if (live) setTiles(rows as Kpi[])
      })
      .catch(() => {
        if (live) setTiles([])
      })
    return () => {
      live = false
    }
  }, [object, hasRecords])

  // Nothing to say is not worth a row. An object with no records has four
  // zeroes, and so does one whose data is complete.
  if (!hasRecords || !tiles || tiles.every((tile) => tile.count === 0)) return null

  return (
    // Wraps rather than scrolls: four short tiles on a phone are two rows, and a
    // row that scrolls sideways hides the tile nobody thought to look for.
    <ul className="flex shrink-0 flex-wrap gap-2">
      {tiles.map((tile) => (
        <li key={tile.key} className="min-w-0 flex-1 basis-[min(12rem,100%)]">
          <Link
            href={objectView(account, object, view, 'list', {
              ...params,
              filters: encodeFilters([...filters, ...tile.filters]),
              // A cursor and an offset from the unfiltered list mean nothing to
              // the filtered one.
              cursor: undefined,
              skip: undefined,
            })}
            className="flex h-full flex-col justify-between gap-0.5 rounded-panel border border-line bg-surface px-3 py-2 text-body no-underline hover:bg-fill"
          >
            <span className="text-small text-secondary">{tile.label}</span>
            <span className="text-base font-semibold tabular-nums">{tile.count.toLocaleString()}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
