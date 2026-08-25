'use server'

import { bookingForToken } from '@rawr/db'
import { redirect } from 'next/navigation'
import { cancelWithProviders, rescheduleWithProviders } from '~/server/booking.ts'

/** The two things an attendee can do to their own meeting, from the link in their
 *  invitation. No session, no account: the token is the credential, and it is
 *  single purpose, so a cancel link cannot move a meeting.
 *
 *  Both are idempotent. Somebody who is not sure it worked will click again, and
 *  clicking cancel twice cancels once. */

export const cancelBookingAction = async (data: FormData): Promise<void> => {
  const token = String(data.get('token') ?? '')
  const reason = String(data.get('reason') ?? '').slice(0, 500)

  const booking = await bookingForToken('cancel', token)
  if (!booking) redirect(`/b/manage/cancel/${encodeURIComponent(token)}?e=unknown`)

  await cancelWithProviders(booking, { reason: reason || null, by: 'attendee' })
  redirect(`/b/manage/cancel/${encodeURIComponent(token)}?done=1`)
}

export const rescheduleBookingAction = async (data: FormData): Promise<void> => {
  const token = String(data.get('token') ?? '')
  const slot = String(data.get('slot') ?? '')
  const timezone = String(data.get('tz') ?? '')
  const back = `/b/manage/reschedule/${encodeURIComponent(token)}`

  const booking = await bookingForToken('reschedule', token)
  if (!booking) redirect(`${back}?e=unknown`)

  const startsAt = new Date(slot)
  if (Number.isNaN(startsAt.getTime())) {
    redirect(`${back}?e=${encodeURIComponent('That time could not be read. Pick one from the list.')}`)
  }

  const outcome = await rescheduleBooking(booking, startsAt, timezone)
  if (!outcome.ok) {
    redirect(`${back}?e=${encodeURIComponent(outcome.message)}&tz=${encodeURIComponent(timezone)}`)
  }

  // The new booking carries its own tokens; the old link is spent. Landing on the
  // new reschedule link means a second change works the same way as the first.
  redirect(
    `/b/manage/reschedule/${encodeURIComponent(outcome.token)}?done=1&tz=${encodeURIComponent(timezone)}`,
  )
}

const rescheduleBooking = async (
  booking: Awaited<ReturnType<typeof bookingForToken>>,
  startsAt: Date,
  timezone: string,
): Promise<{ ok: true; token: string } | { ok: false; message: string }> => {
  if (!booking) return { ok: false, message: 'That link does not match a meeting any more.' }
  const outcome = await rescheduleWithProviders({
    booking,
    startsAt,
    attendeeTimezone: timezone || booking.attendeeTimezone,
  })
  if (!outcome.ok) return { ok: false, message: outcome.message }
  return { ok: true, token: outcome.booking.rescheduleToken }
}
