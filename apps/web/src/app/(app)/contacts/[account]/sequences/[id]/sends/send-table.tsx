'use client'

import type { SequenceState } from '@rawr/db'
import { Badge, DataTable, EmptyState, Pagination, cn, type Column } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { useFormat } from '~/components/zone.tsx'
import { recordPath, sequenceSendsPath, threadPath } from '~/lib/links.ts'
import { useOrigin } from '~/lib/use-origin.ts'
import { SequenceHeader } from '../sequence-header.tsx'

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
  sequence,
  state,
  rows,
  offset,
  perPage,
  hasMore,
}: {
  account: string
  sequence: { id: string; name: string; state: SequenceState; description: string | null }
  state: SendState | null
  rows: SendRow[]
  offset: number
  perPage: number
  hasMore: boolean
}) => {
  const fmt = useFormat()
  const origin = useOrigin()
  const router = useRouter()

  const go = (skip: number) =>
    router.replace(
      sequenceSendsPath(account, sequence.id, {
        state: state ?? undefined,
        skip: skip > 0 ? String(skip) : undefined,
      }),
      { scroll: false },
    )

  const columns: Column<SendRow>[] = [
    {
      key: 'contact',
      header: 'Contact',
      width: 240,
      render: (row) => (
        <span className="flex min-w-0 flex-col py-1">
          {row.contactId ? (
            <Link
              href={recordPath(account, 'contact', row.contactId, { from: origin })}
              title={row.contactName}
              className="truncate font-semibold text-link hover:underline"
            >
              {row.contactName}
            </Link>
          ) : (
            <span className="truncate font-semibold">{row.contactName}</span>
          )}
          <span className="truncate text-small text-secondary">{row.contactEmail ?? 'No email'}</span>
        </span>
      ),
    },
    {
      key: 'subject',
      header: 'Subject',
      width: 280,
      render: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate" title={row.stepSubject ?? undefined}>
            {row.stepSubject ?? 'No subject'}
          </span>
          {row.error ? (
            <span className="truncate text-small text-error" title={row.error}>
              {row.error}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'step',
      header: 'Step',
      width: 110,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-1">
          {row.stepPosition === null ? 'One-off' : `Step ${row.stepPosition + 1}`}
          {/* Only when the step was actually testing a pair. A lone "A" on
              every row says nothing. */}
          {row.variant ? <Badge tone="neutral">{row.variant.toUpperCase()}</Badge> : null}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 170,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-1">
          <Badge tone={STATE_TONE[row.state]} dot>
            {row.state}
          </Badge>
          {row.replied ? <Badge tone="ok">replied</Badge> : null}
        </span>
      ),
    },
    { key: 'opened', header: 'Opened', width: 110, align: 'right', render: (row) => fmt.number(row.openCount) },
    { key: 'clicked', header: 'Clicked', width: 110, align: 'right', render: (row) => fmt.number(row.clickCount) },
    { key: 'sent', header: 'Sent', width: 200, render: (row) => <span className="block truncate">{fmt.dateTime(row.sentAt)}</span> },
    {
      key: 'thread',
      header: 'Thread',
      width: 140,
      // Null until the mailbox sync reads the sent copy back, so the row links
      // to a conversation that exists or to nothing.
      render: (row) =>
        row.threadId ? (
          <Link href={threadPath(account, row.threadId)} className="font-semibold text-link hover:underline">
            Open the thread
          </Link>
        ) : (
          EMPTY_VALUE
        ),
    },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SequenceHeader account={account} sequence={sequence} current="sends" />

      <div role="tablist" aria-label="Send state" className="scroll-fade-x flex min-w-0 overflow-x-auto rounded-t-hs border-b border-line">
        {FILTERS.map((each) => (
          <Link
            key={each.key ?? 'all'}
            role="tab"
            aria-selected={state === each.key}
            href={sequenceSendsPath(account, sequence.id, { state: each.key ?? undefined })}
            className={cn(
              'flex min-h-10 shrink-0 items-center border-r border-line px-4 text-body no-underline last:border-r-0',
              state === each.key ? 'bg-surface font-medium' : 'bg-fill font-normal hover:bg-fill-hover',
            )}
          >
            {each.label}
          </Link>
        ))}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        caption={`What ${sequence.name} sent`}
        storageKey="sequence.sends"
        empty={
          <EmptyState
            title={offset > 0 ? 'Nothing on this page' : 'Nothing sent yet'}
            description={
              offset > 0
                ? 'There were fewer sends than this page needs. Go back a page.'
                : 'A row appears here the moment a step puts a mail on the wire.'
            }
          />
        }
      />

      {offset > 0 || hasMore ? (
        <Pagination
          format={fmt.number}
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
