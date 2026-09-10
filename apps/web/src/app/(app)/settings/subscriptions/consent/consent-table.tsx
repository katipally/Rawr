'use client'

import { Badge, Card, EmptyState, Field, Pagination, Select, TextInput } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { ConsentFilter } from '@rawr/db'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'
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
  const zone = useZone()
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

  const filters = (
    <div className="grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
      <Field id="consent-search" label="Visitor or contact">
        <TextInput
          id="consent-search"
          type="search"
          placeholder="Visitor id, name or email"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </Field>
      <Field id="consent-category" label="What they chose">
        <Select
          id="consent-category"
          value={category ?? ''}
          onChange={(event) => go({ cat: (event.target.value || null) as ConsentFilter | null })}
        >
          <option value="">Any choice</option>
          {FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  )

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {filters}

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
        <Card flush>
          <ul className="divide-y divide-divider">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <span className="flex min-w-0 flex-1 basis-56 flex-col">
                  {/* The id is all there is until something says otherwise: a
                      consent record names nobody, which is the point of it. */}
                  {row.contact ? (
                    <Link href={recordPath(account, 'contact', row.contact.id)} className="truncate font-medium">
                      {row.contact.name}
                    </Link>
                  ) : null}
                  <span className="truncate font-mono text-small">{row.visitorId}</span>
                  {row.userAgent ? (
                    <span className="truncate text-small text-secondary">{row.userAgent}</span>
                  ) : null}
                </span>

                <span className="flex shrink-0 flex-wrap gap-1">
                  <Badge tone="neutral">necessary</Badge>
                  <Badge tone={row.categories.analytics ? 'ok' : 'neutral'}>
                    analytics {row.categories.analytics ? 'yes' : 'no'}
                  </Badge>
                  <Badge tone={row.categories.advertisement ? 'ok' : 'neutral'}>
                    advertising {row.categories.advertisement ? 'yes' : 'no'}
                  </Badge>
                </span>

                <span className="w-32 shrink-0 truncate text-small text-secondary">
                  policy {row.policyVersion}
                </span>

                <span className="w-44 shrink-0 text-small text-secondary">
                  {formatDateTime(row.at, zone)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {offset > 0 || hasMore ? (
        <Pagination
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
