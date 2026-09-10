'use client'

import { Badge, Button, Field, Modal, TextArea, TextInput, buttonClass, type BadgeTone, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'

/** One booked meeting.
 *
 *  Times are rendered in the reader's own zone with the zone name shown, because
 *  a meeting time with no zone on it is the thing people get wrong. That zone is
 *  the one on the session rather than the one the browser reports: the server
 *  renders this row first, and two clocks for one node is what React throws the
 *  server's markup away over. */

const STATES: Record<string, BadgeTone> = {
  confirmed: 'ok',
  cancelled: 'error',
  rescheduled: 'neutral',
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

  const zone = useZone()
  const start = new Date(booking.startsAt)
  const end = new Date(booking.endsAt)
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000)

  const [asking, setAsking] = useState<'cancel' | 'reschedule' | null>(null)
  const [reason, setReason] = useState('')
  const [moveTo, setMoveTo] = useState('')

  const close = () => {
    setAsking(null)
    setReason('')
    setMoveTo('')
  }

  const cancel = async () => {
    setBusy(true)
    try {
      const result = await api.booking.cancel.mutate({
        id: booking.id,
        // The attendee is told why, so an empty box must stay empty rather
        // than become a blank line in the email.
        reason: reason.trim() || null,
      })
      show(
        'success',
        result.alreadyDone
          ? 'That meeting was already cancelled.'
          : 'Cancelled. The calendar event and the invitation are gone.',
      )
      close()
      router.refresh()
    } catch (cause) {
      show('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const reschedule = async () => {
    setBusy(true)
    try {
      // datetime-local has no zone, so it means the reader's own clock, which is
      // the clock the rest of this row is rendered in.
      await api.booking.reschedule.mutate({ id: booking.id, startsAt: new Date(moveTo) })
      show('success', 'Moved. The attendee has the new time and the old slot is free.')
      close()
      router.refresh()
    } catch (cause) {
      // A slot the host is no longer free for comes back as a conflict with a
      // sentence worth reading, so it is shown as-is.
      show('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex flex-col gap-1 rounded-panel border border-line bg-surface p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">
          {formatDateTime(booking.startsAt, zone)}
          {' – '}
          {end.toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' })}
        </span>
        <span className="text-xs text-secondary">{zone}</span>
        <Badge tone={STATES[booking.state] ?? 'neutral'} dot>
          {booking.state}
        </Badge>
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
        {/* A cancelled meeting keeps its conference url, because the provider
            row is what gets torn down and that can fail. Offering it as a link
            invited somebody to join a meeting nobody is coming to. */}
        {booking.state !== 'confirmed' ? null : booking.conferenceUrl ? (
          <a
            href={booking.conferenceUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonClass('secondary', 'no-underline')}
          >
            Join link
          </a>
        ) : (
          <span className="text-xs text-secondary">No conference link on this one.</span>
        )}

        {/* Nothing to cancel once it has happened: the calendar event is in the
            past and the attendee has either turned up or not. */}
        {booking.state === 'confirmed' && editable && end.getTime() > Date.now() ? (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => setAsking('reschedule')}>
              Reschedule
            </Button>
            <Button type="button" variant="destructive" onClick={() => setAsking('cancel')}>
              Cancel
            </Button>
          </span>
        ) : null}
      </div>

      <Modal
        open={asking === 'cancel'}
        size="sm"
        title={`Cancel ${booking.attendeeName}’s meeting`}
        onClose={close}
      >
        <div className="flex flex-col gap-3">
          <Field id={`reason-${booking.id}`} label="Why" hint="Sent to them. Leave it blank to say nothing.">
            <TextArea
              id={`reason-${booking.id}`}
              value={reason}
              rows={3}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" busy={busy} onClick={() => void cancel()}>
              Cancel the meeting
            </Button>
            <Button variant="tertiary" onClick={close}>
              Keep it
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={asking === 'reschedule'}
        size="sm"
        title={`Move ${booking.attendeeName}’s meeting`}
        onClose={close}
      >
        <div className="flex flex-col gap-3">
          <Field
            id={`move-${booking.id}`}
            label="New start"
            hint={`${minutes} minutes. A datetime-local field carries no zone, so this is read in the browser's own clock, not ${zone}. A time the host is not free for is refused.`}
          >
            <TextInput
              id={`move-${booking.id}`}
              type="datetime-local"
              value={moveTo}
              onChange={(event) => setMoveTo(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              busy={busy}
              disabled={moveTo === '' || Number.isNaN(Date.parse(moveTo))}
              onClick={() => void reschedule()}
            >
              Move it
            </Button>
            <Button variant="tertiary" onClick={close}>
              Leave it
            </Button>
          </div>
        </div>
      </Modal>
    </li>
  )
}
