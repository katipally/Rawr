'use client'

import { Badge, Card, EmptyState, Pagination } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'
import { consentRecordsPath } from '~/lib/links.ts'

export type ConsentRow = {
  id: string
  visitorId: string
  categories: { necessary: boolean; analytics: boolean; advertisement: boolean }
  policyVersion: string
  userAgent: string | null
  at: string
}

export const ConsentTable = ({
  rows,
  offset,
  perPage,
  hasMore,
}: {
  rows: ConsentRow[]
  offset: number
  perPage: number
  hasMore: boolean
}) => {
  const zone = useZone()
  const router = useRouter()

  const go = (skip: number) =>
    router.replace(consentRecordsPath({ skip: skip > 0 ? String(skip) : undefined }), {
      scroll: false,
    })

  if (rows.length === 0) {
    return (
      <EmptyState
        title={offset > 0 ? 'Nothing on this page' : 'No choices recorded yet'}
        description={
          offset > 0
            ? 'There were fewer records than this page needs. Go back a page.'
            : 'A row appears the first time somebody answers the banner on a tracked site.'
        }
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Card flush>
        <ul className="divide-y divide-divider">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <span className="flex min-w-0 flex-1 basis-56 flex-col">
                {/* The id is all there is: a consent record names nobody, which
                    is the point of it. */}
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

      {offset > 0 || hasMore ? (
        <Pagination
          count={rows.length}
          offset={offset}
          hasMore={hasMore}
          perPage={perPage}
          noun="records"
          onPrevious={() => go(Math.max(0, offset - perPage))}
          onNext={() => go(offset + perPage)}
        />
      ) : null}
    </div>
  )
}
