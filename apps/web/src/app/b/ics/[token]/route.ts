import { bookingForToken } from '@rawr/db'
import { NextResponse } from 'next/server'
import { buildIcs } from '~/lib/ics.ts'
import { CORS_HEADERS } from '~/server/edge.ts'

/** GET /b/ics/:token.ics
 *
 *  The meeting, for a calendar that is not Google. Google sends its own invitation
 *  to the attendee, but plenty of people book from a phone whose calendar is not
 *  the mailbox that got it, and "add to your calendar" is the button they look for.
 *
 *  The reschedule token is the credential: unguessable, single purpose, and already
 *  in the attendee's hands. It opens nothing the manage page behind the same token
 *  does not already show.
 *
 *  A cancelled meeting still answers, with STATUS:CANCELLED, so importing it clears
 *  an entry somebody added earlier rather than leaving a meeting nobody is coming to.
 *
 *  Static segment before the dynamic one, so /b/ics/:token never collides with
 *  /b/:account/:slug. */

export const dynamic = 'force-dynamic'

export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> => {
  const { token } = await params
  // The extension is in the URL so a phone knows what it downloaded; the token is
  // the part before it.
  const booking = await bookingForToken('reschedule', token.replace(/\.ics$/i, ''))

  if (!booking) {
    return new NextResponse('That link no longer works.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  const ics = buildIcs({
    // The booking id, so a reschedule that replaces this row writes a new entry
    // and a re-import of this one updates in place.
    uid: `${booking.id}@rawr`,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    summary: `${booking.pageName} with ${booking.hostName}`,
    description: booking.conferenceUrl ? `Join: ${booking.conferenceUrl}` : null,
    location: booking.conferenceUrl,
    organiser: { name: booking.hostName, email: booking.hostEmail },
    attendee: { name: booking.attendeeName, email: booking.attendeeEmail },
    cancelled: booking.state === 'cancelled',
  })

  return new NextResponse(ics, {
    headers: {
      ...CORS_HEADERS,
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'attachment; filename="meeting.ics"',
      // The times can change under the same token, so nothing may hold this.
      'cache-control': 'no-store',
    },
  })
}
