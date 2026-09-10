'use client'

import { Card, DataTable, Pagination, Select, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

type Row = {
  sendId: string
  subject: string | null
  to: string | null
  contactId: string | null
  contactName: string | null
  mailbox: string
  sentAt: string
  opens: number
  clicks: number
  firstOpenedAt: string | null
}

type Sort = 'recent' | 'opens' | 'clicks'

const PER_PAGE = 25

/** Item 16. One row per tracked mail.
 *
 *  The charts above say how much mail moved. This is the half somebody acts on:
 *  which mail to which person has been opened six times with no reply yet. Paged
 *  rather than capped, because it is a list to work through. */
export const MessageTable = ({
  account,
  from,
  to,
}: {
  account: string
  from: string
  to: string
}) => {
  const zone = useZone()
  const toast = useToast()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<Sort>('recent')

  const load = useCallback(
    (nextOffset: number, order: Sort) => {
      api.reporting.messages
        .query({ from, to, limit: PER_PAGE, offset: nextOffset, sort: order })
        .then((page) => {
          setRows(
            page.rows.map((row) => ({
              sendId: row.sendId,
              subject: row.subject,
              to: row.to,
              contactId: row.contactId,
              contactName: row.contactName,
              mailbox: row.mailbox,
              sentAt: row.sentAt.toISOString(),
              opens: row.opens,
              clicks: row.clicks,
              firstOpenedAt: row.firstOpenedAt?.toISOString() ?? null,
            })),
          )
          setTotal(page.total)
        })
        .catch((cause) => toast('error', errorMessage(cause)))
    },
    [from, to, toast],
  )

  useEffect(() => {
    setOffset(0)
    load(0, sort)
  }, [load, sort])

  const move = (next: number) => {
    setOffset(next)
    load(next, sort)
  }

  return (
    <Card title="Every tracked mail">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <p className="max-w-prose text-small text-secondary">
            Opens are counted every time the pixel is fetched, so Apple Mail Privacy Protection
            inflates them. Treat one open as "it arrived somewhere" and a click as evidence a person
            was there.
          </p>
          <label className="flex items-center gap-2 text-small">
            <span className="text-secondary">Sort by</span>
            <Select
              id="message-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as Sort)}
            >
              <option value="recent">Most recent</option>
              <option value="opens">Most opened</option>
              <option value="clicks">Most clicked</option>
            </Select>
          </label>
        </div>

        <DataTable
          caption="Tracked messages"
          storageKey="report-messages"
          rows={rows ?? []}
          rowKey={(row) => row.sendId}
          empty={
            <p className="text-secondary">
              {rows === null
                ? 'Reading the tracked mail in this range.'
                : 'No tracked mail was sent in this range. Sequence sends and one-off mail sent from a record are tracked; anything sent straight from Gmail is not.'}
            </p>
          }
          columns={[
            {
              key: 'subject',
              header: 'Subject',
              render: (row) => <span className="truncate">{row.subject ?? '(no subject)'}</span>,
            },
            {
              key: 'to',
              header: 'To',
              render: (row) =>
                row.contactId ? (
                  <Link href={recordPath(account, 'contact', row.contactId)} className="truncate">
                    {row.contactName ?? row.to ?? '(unknown)'}
                  </Link>
                ) : (
                  <span className="truncate">{row.to ?? '(unknown)'}</span>
                ),
            },
            {
              key: 'mailbox',
              header: 'From',
              render: (row) => <span className="truncate text-secondary">{row.mailbox}</span>,
            },
            {
              key: 'sent',
              header: 'Sent',
              width: 190,
              render: (row) => <span className="text-secondary">{formatDateTime(row.sentAt, zone)}</span>,
            },
            {
              key: 'opens',
              header: 'Opens',
              width: 100,
              align: 'right',
              render: (row) => <span className="tabular-nums">{row.opens.toLocaleString()}</span>,
            },
            {
              key: 'clicks',
              header: 'Clicks',
              width: 100,
              align: 'right',
              render: (row) => <span className="tabular-nums">{row.clicks.toLocaleString()}</span>,
            },
            {
              key: 'first',
              header: 'First opened',
              width: 190,
              render: (row) => (
                <span className="text-secondary">
                  {row.firstOpenedAt ? formatDateTime(row.firstOpenedAt, zone) : 'Not yet'}
                </span>
              ),
            },
          ]}
        />

        <Pagination
          count={rows?.length ?? 0}
          offset={offset}
          total={total}
          perPage={PER_PAGE}
          noun="messages"
          onPrevious={() => move(Math.max(offset - PER_PAGE, 0))}
          onNext={() => move(offset + PER_PAGE)}
        />
      </div>
    </Card>
  )
}
