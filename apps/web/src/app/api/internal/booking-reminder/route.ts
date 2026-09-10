import { claimReminder, readReminderTarget, releaseReminder, reminderLabel, systemContext } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { sendBookingMail } from '~/server/booking-mail.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'

/** The worker asking the app to send one pre-meeting reminder.
 *
 *  Here rather than in the worker for the reason the sequence step is: it needs
 *  the Google client and the token refresh that sign-in already owns, and two
 *  places holding somebody's Google credentials is one too many. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as
    | { accountId?: string; bookingId?: string; reminderId?: string }
    | null
  if (!body?.accountId || !body?.bookingId || !body?.reminderId) {
    return NextResponse.json(
      { error: 'An account, a booking and a reminder are all required.' },
      { status: 400 },
    )
  }

  const ctx = systemContext(body.accountId)
  const target = await readReminderTarget(ctx, {
    bookingId: body.bookingId,
    reminderId: body.reminderId,
  })
  // Cancelled, moved, or the reminder was deleted between the scan and now. None
  // of those is a failure to retry.
  if (!target) {
    return NextResponse.json({ sent: false, reason: 'That meeting no longer needs this reminder.' })
  }

  // Claimed before the send, not after: the ledger row is what makes two workers
  // racing send one mail, and writing it afterwards leaves the gap it exists to
  // close.
  const claimed = await claimReminder(ctx, { bookingId: body.bookingId, reminderId: body.reminderId })
  if (!claimed) return NextResponse.json({ sent: false, reason: 'Already reminded.' })

  try {
    const outcome = await sendBookingMail({
      accountId: body.accountId,
      hostUserId: target.hostUserId,
      contactId: target.contactId,
      bookingId: target.bookingId,
      kind: 'reminder',
      label: `${reminderLabel(target.reminder)} reminder`,
      facts: {
        page: target.page,
        hostName: target.hostName,
        hostEmail: target.hostEmail,
        attendeeName: target.attendeeName,
        attendeeEmail: target.attendeeEmail,
        attendeeTimezone: target.attendeeTimezone,
        startsAt: target.startsAt,
        companyName: target.companyName,
        conferenceUrl: target.conferenceUrl,
        rescheduleToken: target.rescheduleToken,
        cancelToken: target.cancelToken,
      },
    })
    return NextResponse.json(outcome)
  } catch (cause) {
    // The claim is undone so the next tick tries again, rather than the meeting
    // passing in silence because one Gmail call timed out.
    await releaseReminder(ctx, { bookingId: body.bookingId, reminderId: body.reminderId })
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 500 },
    )
  }
}
