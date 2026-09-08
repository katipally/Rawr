'use client'

import { Button, Select } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { bookedPath, recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { BookedRow, type BookedRowData } from './booked-row.tsx'

/** The list under the tabs.
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
}) => {
  const router = useRouter()
  const [rows, setRows] = useState(initialRows)
  const [cursor, setCursor] = useState<Cursor>(initialCursor)
  const [links, setLinks] = useState(contactHrefs)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      const result = await api.booking.booked.query({
        when: query.when,
        pageId: query.page,
        hostUserId: query.host,
        state: query.state,
        cursor: { startsAt: new Date(cursor.startsAt), id: cursor.id },
      })
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

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Select
          aria-label="Meeting link"
          value={query.page ?? ''}
          className="max-w-xs"
          onChange={(event) => go({ page: event.target.value || null })}
        >
          <option value="">Every meeting link</option>
          {pages.map((page) => (
            <option key={page.id} value={page.id}>
              {page.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Host"
          value={query.host ?? ''}
          className="max-w-xs"
          onChange={(event) => go({ host: event.target.value || null })}
        >
          <option value="">Every host</option>
          {hosts.map((host) => (
            <option key={host.id} value={host.id}>
              {host.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="State"
          value={query.state ?? ''}
          className="max-w-[12rem]"
          onChange={(event) => go({ state: (event.target.value || null) as Query['state'] })}
        >
          <option value="">Any state</option>
          <option value="confirmed">Confirmed</option>
          <option value="cancelled">Cancelled</option>
          <option value="rescheduled">Rescheduled</option>
        </Select>
      </div>

      <ul className="flex flex-col gap-2">
        {rows.map((booking) => (
          <BookedRow
            key={booking.id}
            booking={booking}
            contactHref={links[booking.id] ?? null}
            editable={editable}
          />
        ))}
      </ul>

      {error ? <p className="mt-3 text-error">{error}</p> : null}

      {cursor ? (
        <Button type="button" busy={busy} className="mt-3" onClick={() => void more()}>
          Show more
        </Button>
      ) : null}
    </>
  )
}
