'use client'

import { Badge, Breadcrumb, Card, EmptyState, Pagination } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'
import { recordPath, sequencePath, sequenceSendsPath, sequencesPath, threadPath } from '~/lib/links.ts'

type SendState = 'sent' | 'failed' | 'bounced'

export type SendRow = {
  id: string
  sentAt: string
  stepPosition: number | null
  stepSubject: string | null
  variant: string | null
  state: SendState
  error: string | null
  openCount: number
  clickCount: number
  replied: boolean
  bounced: boolean
  contactId: string | null
  contactName: string
  contactEmail: string | null
  threadId: string | null
}

const FILTERS: { key: SendState | null; label: string }[] = [
  { key: null, label: 'Every send' },
  { key: 'sent', label: 'Sent' },
  { key: 'failed', label: 'Failed' },
  { key: 'bounced', label: 'Bounced' },
]

const STATE_TONE = { sent: 'ok', failed: 'error', bounced: 'error' } as const

export const SendTable = ({
  account,
  sequenceId,
  sequenceName,
  state,
  rows,
  offset,
  perPage,
  hasMore,
}: {
  account: string
  sequenceId: string
  sequenceName: string
  state: SendState | null
  rows: SendRow[]
  offset: number
  perPage: number
  hasMore: boolean
}) => {
  const zone = useZone()
  const router = useRouter()

  const go = (skip: number) =>
    router.replace(
      sequenceSendsPath(account, sequenceId, {
        state: state ?? undefined,
        skip: skip > 0 ? String(skip) : undefined,
      }),
      { scroll: false },
    )

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Breadcrumb
        items={[
          { label: 'Sequences', href: sequencesPath(account) },
          { label: sequenceName, href: sequencePath(account, sequenceId) },
          { label: 'What it sent' },
        ]}
      />

      <h1 className="text-lg font-medium">What {sequenceName} sent</h1>

      <div className="flex flex-wrap gap-1">
        {FILTERS.map((each) => (
          <Link
            key={each.key ?? 'all'}
            href={sequenceSendsPath(account, sequenceId, { state: each.key ?? undefined })}
            className={
              state === each.key
                ? 'rounded-hs bg-accent-subtle px-3 py-1.5 font-medium text-link no-underline'
                : 'rounded-hs px-3 py-1.5 text-secondary no-underline hover:bg-fill'
            }
          >
            {each.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={offset > 0 ? 'Nothing on this page' : 'Nothing sent yet'}
          description={
            offset > 0
              ? 'There were fewer sends than this page needs. Go back a page.'
              : 'A row appears here the moment a step puts a mail on the wire.'
          }
        />
      ) : (
        <Card flush>
          <ul className="divide-y divide-divider">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <span className="flex min-w-0 flex-1 basis-56 flex-col">
                  {row.contactId ? (
                    <Link
                      href={recordPath(account, 'contact', row.contactId)}
                      className="truncate font-medium"
                    >
                      {row.contactName}
                    </Link>
                  ) : (
                    <span className="truncate font-medium">{row.contactName}</span>
                  )}
                  <span className="truncate text-small text-secondary">
                    {row.stepSubject ?? row.contactEmail ?? 'No subject'}
                  </span>
                  {row.error ? (
                    <span className="truncate text-small text-error">{row.error}</span>
                  ) : null}
                </span>

                <span className="w-20 shrink-0 text-small text-secondary tabular-nums">
                  {row.stepPosition === null ? 'one-off' : `step ${row.stepPosition + 1}`}
                </span>

                {/* Only when the step was actually testing a pair. A lone "A" on
                    every row says nothing and costs a column. */}
                {row.variant ? (
                  <Badge tone="neutral">subject {row.variant.toUpperCase()}</Badge>
                ) : null}

                <Badge tone={STATE_TONE[row.state]} dot>
                  {row.state}
                </Badge>

                {row.replied ? <Badge tone="ok">replied</Badge> : null}

                <span className="w-40 shrink-0 text-small text-secondary tabular-nums">
                  {row.openCount} opened · {row.clickCount} clicked
                </span>

                <span className="w-44 shrink-0 text-small text-secondary">
                  {formatDateTime(row.sentAt, zone)}
                </span>

                {/* Null until the mailbox sync reads the sent copy back, so the
                    row links to a conversation that exists or to nothing. */}
                {row.threadId ? (
                  <Link href={threadPath(account, row.threadId)} className="shrink-0 text-small">
                    Open the thread
                  </Link>
                ) : null}
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
          noun="sends"
          onPrevious={() => go(Math.max(0, offset - perPage))}
          onNext={() => go(offset + perPage)}
        />
      ) : null}
    </div>
  )
}
