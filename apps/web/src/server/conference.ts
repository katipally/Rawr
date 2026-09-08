import { attachConference, publicEdgeContext, readBooking, recordDeadLetter } from '@rawr/db'
import { publicBaseUrl } from '~/lib/env.ts'
import { bookedPath } from '~/lib/links.ts'
import { inBackground } from './background.ts'
import { patchCalendarEvent } from './calendar.ts'
import { queueHostAlert } from './notify.ts'
import { createZoomMeeting } from './zoom.ts'

/** F2 §4 step 5, the half that happens after the visitor has gone.
 *
 *  Zoom being down does not lose a booking, so the meeting is written without a
 *  link and the link is chased afterwards. The event already says one is coming,
 *  which is the sentence this replaces when a link finally arrives. If none ever
 *  does, the host is told, and the attempt lands in dead_letter with the real
 *  Zoom error so it can be replayed rather than guessed at. */

export const PENDING_LINE = 'A Zoom link is being added to this event.'

/** What the visitor is told. The Zoom error names our deployment's problems and
 *  belongs to the host, not to a stranger who just booked a call. */
export const PENDING_NOTICE =
  'Your joining link is still being created. It will appear on your calendar invitation shortly.'

export type PendingConference = {
  accountId: string
  bookingId: string
  /** The strings already rendered for the event, reused verbatim so a retry cannot
   *  produce a Zoom meeting titled differently from its own calendar entry. */
  topic: string
  agenda: string
  /** The description as written to the event, still carrying PENDING_LINE. */
  description: string
  /** The failure that put this here, kept for the host and the dead letter. */
  reason: string
}

const ATTEMPTS = 4

/** Not awaited: the booking is already committed and the visitor is looking at
 *  their confirmation. The chase backs off across four attempts and can run for
 *  over a minute, which is far longer than the response it follows, so it is
 *  registered with the runtime rather than left as a promise nobody holds. */
export const queueConferenceBackfill = (pending: PendingConference): void => {
  inBackground(`zoom backfill for booking ${pending.bookingId}`, () => chase(pending))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const chase = async (pending: PendingConference): Promise<void> => {
  const ctx = publicEdgeContext(pending.accountId)
  let lastError = pending.reason

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // Backoff first: the call that just failed failed a moment ago, and Zoom
    // outages are measured in minutes rather than milliseconds.
    await sleep(2 ** (attempt - 1) * 5_000 * (1 + Math.random()))

    const booking = await readBooking(ctx, pending.bookingId).catch(() => null)
    // Cancelled, moved, or given a link by a reschedule in the meantime. All three
    // mean there is nothing left to chase.
    if (!booking || booking.state !== 'confirmed' || booking.conferenceUrl) return
    if (booking.startsAt.getTime() < Date.now()) return

    const outcome = await createZoomMeeting(ctx, {
      hostEmail: booking.hostEmail,
      topic: pending.topic,
      agenda: pending.agenda,
      startsAt: booking.startsAt,
      durationMinutes: Math.round((booking.endsAt.getTime() - booking.startsAt.getTime()) / 60_000),
      timezone: booking.attendeeTimezone,
    })

    if (!outcome.ok) {
      lastError = outcome.reason
      continue
    }

    const claimed = await attachConference(ctx, booking.id, {
      url: outcome.meeting.joinUrl,
      ref: outcome.meeting.meetingId,
    })
    // Somebody else got there first. Two join links on one meeting is worse than
    // one, so this one is withdrawn rather than left orphaned in Zoom.
    if (!claimed) return

    if (booking.calendarEventId && booking.calendarId) {
      await patchCalendarEvent(ctx, {
        userId: booking.hostUserId,
        calendarId: booking.calendarId,
        eventId: booking.calendarEventId,
        description: pending.description.replace(PENDING_LINE, `Join: ${outcome.meeting.joinUrl}`),
      }).catch(async (cause) => {
        // The link is on the booking and in the CRM; only the calendar entry is
        // stale. Recorded rather than retried, because the row is already right.
        await record(pending, `Link created but the calendar event was not updated: ${describe(cause)}`, attempt)
      })
    }
    return
  }

  await announce(ctx, pending, lastError)
}

/** Nobody is watching a background retry, so the last word goes to the people who
 *  can add a link by hand. */
const announce = async (
  ctx: ReturnType<typeof publicEdgeContext>,
  pending: PendingConference,
  reason: string,
): Promise<void> => {
  const booking = await readBooking(ctx, pending.bookingId).catch(() => null)
  if (!booking || booking.state !== 'confirmed' || booking.conferenceUrl) return

  const when = booking.startsAt.toISOString().replace('T', ' ').slice(0, 16)
  queueHostAlert({
    accountId: pending.accountId,
    jobName: 'slack.booking-no-conference',
    // Keyed on the booking: one meeting without a link, one alert, however many
    // times the chase gives up.
    idempotencyKey: `slack:booking-no-conference:${pending.bookingId}`,
    payload: { bookingId: pending.bookingId, hostEmail: booking.hostEmail, reason },
    text: [
      `*No Zoom link on a confirmed meeting.* ${booking.hostName} with ${booking.attendeeName}, ${when} UTC.`,
      `Zoom said: ${reason}`,
      'Add a link to the calendar event by hand, or replay this once Zoom is back.',
      `<${publicBaseUrl}${bookedPath(booking.accountSlug)}|Open the booked list>`,
    ].join('\n'),
  })
  await record(pending, reason, ATTEMPTS)
}

const record = async (pending: PendingConference, error: string, attempts: number): Promise<void> => {
  try {
    await recordDeadLetter(publicEdgeContext(pending.accountId), {
      jobName: 'zoom.backfill',
      payload: { bookingId: pending.bookingId, topic: pending.topic },
      error,
      attempts,
    })
  } catch {
    // The database is the last place this could be written. The meeting itself is
    // safe either way.
  }
}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
