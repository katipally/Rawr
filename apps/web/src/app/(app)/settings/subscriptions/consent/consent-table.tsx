'use client'

import { DataTable, EmptyState, Pagination, type Column } from '@rawr/ui'
import { Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { ConsentFilter } from '@rawr/db'
import { FilterChip } from '~/components/filter-chip.tsx'
import { StatusDot } from '~/components/row-actions.tsx'
import { useFormat } from '~/components/zone.tsx'
import { consentRecordsPath, recordPath } from '~/lib/links.ts'

export type ConsentRow = {
  id: string
  visitorId: string
  categories: { necessary: boolean; analytics: boolean; advertisement: boolean }
  policyVersion: string
  userAgent: string | null
  at: string
  contact: { id: string; name: string } | null
}

const FILTERS: { value: ConsentFilter; label: string }[] = [
  { value: 'analytics', label: 'Agreed to analytics' },
  { value: 'no-analytics', label: 'Refused analytics' },
  { value: 'advertisement', label: 'Agreed to advertising' },
  { value: 'no-advertisement', label: 'Refused advertising' },
]

export const ConsentTable = ({
  rows,
  offset,
  perPage,
  hasMore,
  search,
  category,
  account,
}: {
  rows: ConsentRow[]
  offset: number
  perPage: number
  hasMore: boolean
  search: string
  category: ConsentFilter | null
  account: string
}) => {
  const fmt = useFormat()
  const router = useRouter()
  const [draft, setDraft] = useState(search)

  /** Both filters are the address, so a page of evidence can be linked to in the
   *  answer somebody has to give. A filter change starts the list again: page
   *  four of one filter is not a page of another. */
  const go = (next: { skip?: number; cat?: ConsentFilter | null }) => {
    const cat = next.cat === undefined ? category : next.cat
    const skip = next.skip ?? 0
    router.replace(
      consentRecordsPath({
        ...(skip > 0 ? { skip: String(skip) } : {}),
        ...(search ? { q: search } : {}),
        ...(cat ? { cat } : {}),
      }),
      { scroll: false },
    )
  }

  // One navigation after the typing stops rather than one per keystroke.
  useEffect(() => {
    const needle = draft.trim()
    if (needle === search) return
    const timer = window.setTimeout(() => {
      router.replace(
        consentRecordsPath({ ...(needle ? { q: needle } : {}), ...(category ? { cat: category } : {}) }),
        { scroll: false },
      )
    }, 250)
    return () => window.clearTimeout(timer)
  }, [draft, search, category, router])

  const yesNo = (on: boolean) => <StatusDot tone={on ? 'live' : 'off'}>{on ? 'Agreed' : 'Refused'}</StatusDot>

  const columns: Column<ConsentRow>[] = [
    {
      key: 'visitor',
      header: 'Visitor',
      width: 320,
      render: (row) => (
        <span className="flex min-w-0 flex-col py-1">
          {/* The id is all there is until something says otherwise: a consent
              record names nobody, which is the point of it. */}
          {row.contact ? (
            <Link href={recordPath(account, 'contact', row.contact.id)} title={row.contact.name} className="truncate font-semibold">
              {row.contact.name}
            </Link>
          ) : null}
          <span title={row.visitorId} className="truncate font-mono text-small">{row.visitorId}</span>
          {row.userAgent ? <span title={row.userAgent} className="truncate text-small font-light text-secondary">{row.userAgent}</span> : null}
        </span>
      ),
    },
    { key: 'necessary', header: 'Necessary', width: 130, render: () => yesNo(true) },
    { key: 'analytics', header: 'Analytics', width: 130, render: (row) => yesNo(row.categories.analytics) },
    { key: 'advertisement', header: 'Advertising', width: 130, render: (row) => yesNo(row.categories.advertisement) },
    { key: 'policy', header: 'Policy', width: 120, render: (row) => <span title={row.policyVersion} className="block truncate font-light">{row.policyVersion}</span> },
    { key: 'at', header: 'Recorded', width: 200, render: (row) => <span className="font-light">{fmt.dateTime(row.at)}</span> },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative w-full min-w-0 @lg:w-[18rem]">
          <span className="sr-only">Search visitor or contact</span>
          <input
            type="search"
            placeholder="Visitor id, name or email"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-[2.5rem] w-full rounded-pill border border-line-strong bg-surface py-2 pr-10 pl-4 font-light placeholder:text-muted"
          />
          <Search aria-hidden="true" className="absolute top-1/2 right-4 size-4 -translate-y-1/2" />
        </label>
        <FilterChip
          label="Choice"
          clear={consentRecordsPath(search ? { q: search } : {})}
          options={FILTERS.map((option) => ({
            key: option.value,
            label: option.label,
            href: consentRecordsPath({ ...(search ? { q: search } : {}), cat: option.value }),
            on: category === option.value,
          }))}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={
            search || category
              ? 'Nothing matches'
              : offset > 0
                ? 'Nothing on this page'
                : 'No choices recorded yet'
          }
          description={
            search || category
              ? 'Clear the search or widen the filter to see the rest.'
              : offset > 0
                ? 'There were fewer records than this page needs. Go back a page.'
                : 'A row appears the first time somebody answers the banner on a tracked site.'
          }
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Consent records" storageKey="settings.consent" />
      )}

      {offset > 0 || hasMore ? (
        <Pagination
          format={fmt.number}
          count={rows.length}
          offset={offset}
          hasMore={hasMore}
          perPage={perPage}
          noun="records"
          onPrevious={() => go({ skip: Math.max(0, offset - perPage) })}
          onNext={() => go({ skip: offset + perPage })}
        />
      ) : null}
    </div>
  )
}
