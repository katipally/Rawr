'use client'

import { Skeleton } from '@rawr/ui'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { encodeFilters, objectView, type ListParams } from '~/lib/links.ts'
import { trpc } from '~/lib/rpc.ts'
import { useUi, useUiReady } from '~/lib/store/ui.ts'
import type { Group } from './filter-builder.tsx'
import { useFormat } from '~/components/zone.tsx'

type Kpi = { key: string; label: string; count: number; filters: Group[] }

/** Four blank tiles the size of real ones, so the strip takes its space before
 *  it knows what to put in it. Every object's strip is four wide. */
const PLACEHOLDERS: Kpi[] = [0, 1, 2, 3].map((n) => ({
  key: `placeholder-${n}`,
  label: '\u00a0',
  count: 0,
  filters: [],
}))

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
 *  fails: a broken count is not worth an error above somebody's list.
 *
 *  Read through the shared cache, so a bulk action that changes what is missing
 *  invalidates `trpc.crm.kpis` and the tiles refetch instead of keeping the old
 *  counts. */
export const KpiStrip = ({ account, object, view, params, filters, hasRecords }: KpiStripProps) => {
  const fmt = useFormat()
  // Collapsed is a statement about this person's screen, not about the list, so it
  // follows them to every list rather than riding in an address they might paste.
  // Open until their preferences arrive, so the first paint matches the server's.
  // The toolbar's collapse chevron is what sets it.
  const collapsed = useUi((state) => state.panelOpen.kpis) === false
  const expanded = !useUiReady() || !collapsed
  const { data, isError } = useQuery({
    ...trpc.crm.kpis.queryOptions({ object, filters, search: params.q ?? '' }),
    enabled: hasRecords && expanded,
  })
  const tiles = (data as Kpi[] | undefined) ?? (isError ? [] : null)

  // Nothing to say is not worth a row. An object with no records has four
  // zeroes, and so does one whose data is complete.
  if (!hasRecords || !expanded) return null

  if (tiles?.every((tile) => tile.count === 0)) return null

  // The counts arrive after the rows do, so the strip holds its own height in
  // the meantime: one that appears late pushes the table down under a cursor
  // already aimed at it, and the click lands on a tile.
  const shells = tiles ?? PLACEHOLDERS

  return (
    // Wraps rather than scrolls: four tiles on a phone are two rows, and a row
    // that scrolls sideways hides the tile nobody thought to look for.
    <ul aria-busy={tiles ? undefined : true} className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))] p-1">
      {shells.map((tile) => (
        <li key={tile.key} className="relative min-w-0 pr-3">
          <Link
            aria-hidden={tiles ? undefined : true}
            tabIndex={tiles ? undefined : -1}
            href={objectView(account, object, view, 'list', {
              ...params,
              filters: encodeFilters([...filters, ...tile.filters]),
              // A page of the unfiltered list means nothing to the filtered one.
              page: undefined,
            })}
            title={`${fmt.number(tile.count)} ${tile.label.toLowerCase()}`}
            className={`group flex flex-col items-center text-center text-body no-underline${tiles ? '' : ' pointer-events-none invisible'}`}
          >
            <span className="max-w-full truncate text-small font-semibold uppercase">{tile.label}</span>
            <span className="text-kpi font-semibold text-link tabular-nums group-hover:text-accent group-hover:underline">
              {fmt.number(tile.count, { notation: 'compact', maximumFractionDigits: 2 })}
            </span>
          </Link>
          {tiles ? null : <Skeleton className="absolute inset-0 mr-3 h-full rounded-panel" />}
        </li>
      ))}
    </ul>
  )
}
