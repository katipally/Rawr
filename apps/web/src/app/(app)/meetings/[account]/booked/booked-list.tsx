'use client'

import { Button, DataTable, DropdownMenu, type Column } from '@rawr/ui'
import { ChevronDown } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { StatusDot, type StatusTone } from '~/components/row-actions.tsx'
import { useFormat, useZone } from '~/components/zone.tsx'
import { bookedPath, recordPath } from '~/lib/links.ts'
import { errorMessage, trpc } from '~/lib/rpc.ts'
import { BookedActions, type BookedRowData } from './booked-row.tsx'
import { useQueryClient } from '@tanstack/react-query'

const STATES: Record<string, { tone: StatusTone; label: string }> = {
  confirmed: { tone: 'live', label: 'Confirmed' },
  cancelled: { tone: 'off', label: 'Cancelled' },
  rescheduled: { tone: 'pending', label: 'Rescheduled' },
}

const ghost =
  'inline-flex min-h-[2.4375rem] max-w-full items-center gap-1 rounded-hs px-3 font-semibold text-body transition-all duration-150 ease-out hover:bg-fill'

/** The table under the tabs, as HubSpot lists meetings: the attendee with Join,
 *  Reschedule and Cancel on the hovered row, when it starts in the reader's
 *  zone, the link it came through, the host and its state, under ghost
 *  Meeting link, Host and Status filters.
 *
 *  The filters live in the address, so a filtered view pastes into Slack; the
 *  pages after the first do not, because a keyset cursor is a pair of values
 *  nobody should have to see in a URL. So the first page is rendered by the
 *  server from the address, and Show more appends to it from here. */

export type Query = {
  when: 'upcoming' | 'past'
  page: string | null
  host: string | null
  state: 'confirmed' | 'cancelled' | 'rescheduled' | null
}

type Cursor = { startsAt: string; id: string } | null

export const BookedList = ({
  account,
  query,
  hosts,
  pages,
  initialRows,
  initialCursor,
  contactHrefs,
  editable,
  empty,
}: {
  account: string
  query: Query
  hosts: { id: string; name: string }[]
  pages: { id: string; name: string }[]
  initialRows: BookedRowData[]
  initialCursor: Cursor
  /** Booking id to the contact's record, built on the server where the link
   *  builder and the account slug both live. */
  contactHrefs: Record<string, string>
  editable: boolean
  /** Said under the filters when nothing matches them or nothing is booked. */
  empty: ReactNode
}) => {
  const fmt = useFormat()
  const zone = useZone()
  const queryClient = useQueryClient()
  const router = useRouter()
  const [rows, setRows] = useState(initialRows)
  const [cursor, setCursor] = useState<Cursor>(initialCursor)
  const [links, setLinks] = useState(contactHrefs)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A refresh after a move or a cancel delivers new server rows. Load-more rows
  // from before it are dropped, which is what the server now says is true.
  const [fromServer, setFromServer] = useState(initialRows)
  if (fromServer !== initialRows) {
    setFromServer(initialRows)
    setRows(initialRows)
    setCursor(initialCursor)
    setLinks(contactHrefs)
  }

  const go = (change: Partial<Query>) => {
    const next = { ...query, ...change }
    router.push(
      bookedPath(account, {
        when: next.when,
        ...(next.page ? { page: next.page } : {}),
        ...(next.host ? { host: next.host } : {}),
        ...(next.state ? { state: next.state } : {}),
      }),
    )
  }

  const more = async () => {
    if (!cursor) return
    setBusy(true)
    setError(null)
    try {
      const result = await queryClient.fetchQuery({ ...trpc.booking.booked.queryOptions({
        when: query.when,
        pageId: query.page,
        hostUserId: query.host,
        state: query.state,
        cursor: { startsAt: new Date(cursor.startsAt), id: cursor.id },
      }), staleTime: 0 })
      setRows((all) => [
        ...all,
        ...result.rows.map((row) => ({
          id: row.id,
          pageName: row.pageName,
          hostName: row.hostName,
          attendeeName: row.attendeeName,
          attendeeEmail: row.attendeeEmail,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          state: row.state,
          conferenceUrl: row.conferenceUrl,
        })),
      ])
      setLinks((all) => ({
        ...all,
        ...Object.fromEntries(
          result.rows.flatMap((row) =>
            row.contactId ? [[row.id, recordPath(account, 'contact', row.contactId)]] : [],
          ),
        ),
      }))
      setCursor(
        result.nextCursor
          ? { startsAt: result.nextCursor.startsAt.toISOString(), id: result.nextCursor.id }
          : null,
      )
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const filter = (
    label: string,
    value: string | null,
    options: { id: string; name: string }[],
    every: string,
    onSelect: (id: string | null) => void,
  ) => (
    <DropdownMenu
      label={label}
      align="start"
      groups={[
        {
          key: label,
          items: [
            { key: 'any', label: every, checked: value === null, onSelect: () => onSelect(null) },
            ...options.map((option) => ({
              key: option.id,
              label: option.name,
              checked: value === option.id,
              onSelect: () => onSelect(option.id),
            })),
          ],
        },
      ]}
      trigger={(props) => (
        <button {...props} type="button" className={ghost}>
          <span className="font-light">{label}:</span>
          <span className="max-w-48 truncate">{options.find((option) => option.id === value)?.name ?? every}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
        </button>
      )}
    />
  )

  const columns: Column<BookedRowData>[] = [
    {
      key: 'meeting',
      header: 'Meeting',
      width: 380,
      render: (booking) => {
        const href = links[booking.id]
        return (
          <span className="flex min-w-0 items-center gap-2 py-1">
            <span className="flex min-w-0 flex-1 flex-col items-start">
              {href ? (
                <Link href={href} title={booking.attendeeName} className="max-w-full truncate font-semibold">
                  {booking.attendeeName}
                </Link>
              ) : (
                <span title={booking.attendeeName} className="max-w-full truncate font-semibold">
                  {booking.attendeeName}
                </span>
              )}
              <span title={booking.attendeeEmail} className="max-w-full truncate text-small text-secondary">
                {booking.attendeeEmail}
              </span>
            </span>
            <BookedActions booking={booking} editable={editable} />
          </span>
        )
      },
    },
    {
      key: 'start',
      header: 'Start time',
      width: 290,
      // In the reader's own zone with the zone named, because a meeting time
      // with no zone on it is the thing people get wrong.
      render: (booking) => (
        <span className="flex min-w-0 flex-col">
          <span>
            {fmt.dateTime(booking.startsAt)}
            {' - '}
            {fmt.time(new Date(booking.endsAt))}
          </span>
          <span className="truncate text-small text-secondary">{zone}</span>
        </span>
      ),
    },
    { key: 'page', header: 'Meeting link', width: 200, render: (booking) => <span className="truncate">{booking.pageName}</span> },
    { key: 'host', header: 'Host', width: 170, render: (booking) => <span className="truncate">{booking.hostName}</span> },
    {
      key: 'state',
      header: 'Status',
      width: 150,
      render: (booking) => (
        <StatusDot tone={STATES[booking.state]?.tone ?? 'off'}>{STATES[booking.state]?.label ?? booking.state}</StatusDot>
      ),
    },
  ]

  const filtered = query.page !== null || query.host !== null || query.state !== null

  return (
    <>
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        {filter('Meeting link', query.page, pages, 'Every meeting link', (page) => go({ page }))}
        {filter('Host', query.host, hosts, 'Every host', (host) => go({ host }))}
        {filter(
          'Status',
          query.state,
          Object.entries(STATES).map(([id, state]) => ({ id, name: state.label })),
          'Any status',
          (state) => go({ state: state as Query['state'] }),
        )}
        {filtered ? (
          <button type="button" className={`${ghost} text-muted`} onClick={() => go({ page: null, host: null, state: null })}>
            Clear filters
          </button>
        ) : null}
      </div>

      {rows.length > 0 ? (
        <DataTable columns={columns} rows={rows} rowKey={(booking) => booking.id} caption="Booked meetings" storageKey="meetings.booked" />
      ) : (
        empty
      )}

      {error ? <p className="mt-3 text-error">{error}</p> : null}

      {cursor ? (
        <Button type="button" busy={busy} className="mt-3" onClick={() => void more()}>
          Show more
        </Button>
      ) : null}
    </>
  )
}
