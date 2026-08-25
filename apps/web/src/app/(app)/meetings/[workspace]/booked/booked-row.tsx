'use client'

import { Button, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

/** One booked meeting.
 *
 *  Times are rendered in the browser's own zone with the zone name shown, because
 *  a meeting time with no zone on it is the thing people get wrong. The instant is
 *  passed in as an ISO string and formatted here rather than on the server, so a
 *  person in Jakarta reading a Los Angeles rep's screen sees their own clock. */

const STATES: Record<string, string> = {
  confirmed: 'bg-success-subtle text-success',
  cancelled: 'bg-error-subtle text-error',
  rescheduled: 'bg-disabled text-secondary',
}

export type BookedRowData = {
  id: string
  pageName: string
  hostName: string
  attendeeName: string
  attendeeEmail: string
  startsAt: string
  endsAt: string
  state: string
  conferenceUrl: string | null
}

export const BookedRow = ({
  booking,
  contactHref,
  editable,
}: {
  booking: BookedRowData
  contactHref: string | null
  editable: boolean
}) => {
  const show = useToast()
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const start = new Date(booking.startsAt)
  const end = new Date(booking.endsAt)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

  const cancel = async () => {
    setBusy(true)
    try {
      const result = await api.booking.cancel.mutate({ id: booking.id })
      show(
        'success',
        result.alreadyDone
          ? 'That meeting was already cancelled.'
          : 'Cancelled. The calendar event and the invitation are gone.',
      )
      router.refresh()
    } catch (cause) {
      show('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex flex-col gap-1 rounded-panel border border-line bg-surface p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">
          {start.toLocaleString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
          {' – '}
          {end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
        </span>
        <span className="text-xs text-secondary">{zone}</span>
        <span className={`rounded-hs px-1.5 py-0.5 text-xs ${STATES[booking.state] ?? ''}`}>
          {booking.state}
        </span>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        {contactHref ? (
          <Link href={contactHref} className="font-semibold text-link">
            {booking.attendeeName}
          </Link>
        ) : (
          <span className="font-medium">{booking.attendeeName}</span>
        )}
        <span className="text-secondary">{booking.attendeeEmail}</span>
        <span className="text-secondary">
          {booking.pageName} · {booking.hostName}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {booking.conferenceUrl ? (
          <a href={booking.conferenceUrl} target="_blank" rel="noreferrer">
            Join link
          </a>
        ) : booking.state === 'confirmed' ? (
          <span className="text-xs text-secondary">No conference link on this one.</span>
        ) : null}

        {booking.state === 'confirmed' && editable ? (
          <Button
            type="button"
            variant="destructive"
            busy={busy}
            className="ml-auto"
            onClick={() => void cancel()}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </li>
  )
}
