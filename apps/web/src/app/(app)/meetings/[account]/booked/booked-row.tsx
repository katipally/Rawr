'use client'

import { Button, Field, Modal, TextArea, TextInput, TimeField, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { RowActions, rowPill } from '~/components/row-actions.tsx'
import { useFormat, useZone } from '~/components/zone.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'

/** What can be done to one booked meeting, as the pills after its attendee on
 *  the hovered row: join it, move it, or cancel it, each move and cancel asking
 *  in a dialog first. The zone named in the move dialog is the one on the
 *  session rather than the one the browser reports, because the server renders
 *  the row first and two clocks for one node is what React throws the server's
 *  markup away over. */

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

export const BookedActions = ({ booking, editable }: { booking: BookedRowData; editable: boolean }) => {
  const show = useToast()
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const zone = useZone()
  const { locale } = useFormat()
  const end = new Date(booking.endsAt)

  const [asking, setAsking] = useState<'cancel' | 'reschedule' | null>(null)
  const [reason, setReason] = useState('')
  const [moveDate, setMoveDate] = useState('')
  const [moveTime, setMoveTime] = useState('')

  const parsedMove = new Date(`${moveDate}T${moveTime}`)
  const movedAt = moveDate && moveTime && !Number.isNaN(parsedMove.getTime()) ? parsedMove : null

  const close = () => {
    setAsking(null)
    setReason('')
    setMoveDate('')
    setMoveTime('')
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
    if (!movedAt) return
    setBusy(true)
    try {
      // The date and the time carry no zone, so they mean the reader's own clock,
      // which is the clock the rest of this row is rendered in.
      await api.booking.reschedule.mutate({ id: booking.id, startsAt: movedAt })
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

  // A cancelled meeting keeps its conference url, because the provider row is
  // what gets torn down and that can fail. Offering it as a link invited
  // somebody to join a meeting nobody is coming to. And nothing is moved or
  // cancelled once it has happened: the calendar event is in the past and the
  // attendee has either turned up or not.
  const joinable = booking.state === 'confirmed' && booking.conferenceUrl !== null
  const changeable = booking.state === 'confirmed' && editable && end.getTime() > Date.now()

  return (
    <>
      {joinable || changeable ? (
        <RowActions>
          {joinable ? (
            <a href={booking.conferenceUrl ?? undefined} target="_blank" rel="noreferrer" className={rowPill}>
              Join
            </a>
          ) : null}
          {changeable ? (
            <>
              <button type="button" className={rowPill} onClick={() => setAsking('reschedule')}>
                Reschedule
              </button>
              <button type="button" className={rowPill} onClick={() => setAsking('cancel')}>
                Cancel
              </button>
            </>
          ) : null}
        </RowActions>
      ) : null}

      <Modal
        open={asking === 'cancel'}
        size="sm"
        title={`Cancel ${booking.attendeeName}’s meeting`}
        onClose={close}
        dirty={reason !== ''}
        footer={
          <>
            <Button variant="destructive" busy={busy} onClick={() => void cancel()}>
              Cancel the meeting
            </Button>
            <Button variant="tertiary" onClick={close}>
              Keep it
            </Button>
          </>
        }
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
        </div>
      </Modal>

      <Modal
        open={asking === 'reschedule'}
        size="sm"
        title={`Move ${booking.attendeeName}’s meeting`}
        onClose={close}
        onSubmit={() => void reschedule()}
        footer={
          <>
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={movedAt === null}
            >
              Move it
            </Button>
            <Button variant="tertiary" onClick={close}>
              Leave it
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field id={`move-date-${booking.id}`} label="New date">
            <TextInput
              id={`move-date-${booking.id}`}
              type="date"
              value={moveDate}
              onChange={(event) => setMoveDate(event.target.value)}
            />
          </Field>
          <Field
            id={`move-time-${booking.id}`}
            label="New start"
            hint={`Times are in your browser's time zone, not ${zone}. A time the host is not free for is refused.`}
          >
            <TimeField
              id={`move-time-${booking.id}`}
              locale={locale}
              value={moveTime}
              onChange={setMoveTime}
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
