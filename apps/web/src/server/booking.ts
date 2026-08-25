import {
  cancelBooking,
  confirmBooking,
  isKnownTimezone,
  publicEdgeContext,
  readBookingPage,
  readHolds,
  readPageHosts,
  SlotGoneError,
  computeOffer,
  type BookingPageConfig,
  type BookingRecord,
  type ConfirmResult,
  type HostAvailability,
  type Interval,
  type OfferedSlot,
  type ProvisionRequest,
  type Provisioned,
  bookingTemplateValues,
  renderTemplate,
  type WorkspaceContext,
} from '@rawr/db'
import {
  busyForHosts,
  createCalendarEvent,
  deleteCalendarEvent,
  patchCalendarEvent,
} from './calendar.ts'
import { publicBaseUrl } from '~/lib/env.ts'
import { bookingManagePath } from '~/lib/links.ts'

import { createZoomMeeting, deleteZoomMeeting, updateZoomMeeting } from './zoom.ts'
import {
  PENDING_LINE,
  PENDING_NOTICE,
  queueConferenceBackfill,
  type PendingConference,
} from './conference.ts'

/** F2 §4. The order of operations for a booking, in one place.
 *
 *  The engine in the data access layer knows the arithmetic and the invariants; the
 *  calendar and Zoom clients know how to talk to a provider. This is the only file
 *  that knows what happens in what order, which is where the interesting failures
 *  live: what a person sees when Google is slow, and what is written when Zoom is
 *  down. */

export type OfferWindow = { from: Date; to: Date; now?: Date }

export type PublicOffer = {
  slots: { startsAt: Date; hostUserIds: string[] }[]
  /** Set when availability genuinely could not be established. The page says so
   *  and offers nothing, rather than falling back to the weekly window and
   *  double booking somebody. F2 §2. */
  unavailable: string | null
  /** For the admin health panel. Never shown to a visitor: it names staff. */
  problems: string[]
}

const ONE_DAY = 86_400_000

/** What the booking page renders. Reads free-busy through the sixty second cache,
 *  because a month view is requested repeatedly while somebody clicks around and
 *  the submit path re-reads it anyway. */
export const loadOffer = async (
  page: BookingPageConfig,
  window: OfferWindow,
): Promise<PublicOffer> => {
  const ctx = publicEdgeContext(page.workspaceId)
  const now = window.now ?? new Date()

  // A day either side, because a slot at the edge of the requested range needs the
  // host's window on the neighbouring day to be resolved.
  const padded = {
    from: new Date(window.from.getTime() - ONE_DAY),
    to: new Date(window.to.getTime() + ONE_DAY),
  }

  const hosts = await readPageHosts(ctx, page.bookingPageId, padded)
  if (hosts.length === 0) {
    return {
      slots: [],
      unavailable: 'This booking page has no hosts, so there is nothing to offer yet.',
      problems: [],
    }
  }

  const [{ busy, problems }, holds] = await Promise.all([
    busyForHosts(ctx, hosts, padded),
    readHolds(ctx, page.bookingPageId, padded),
  ])

  const offer = computeOffer({
    page,
    hosts,
    externalBusy: busy,
    holds,
    from: window.from,
    to: window.to,
    now,
  })

  return {
    slots: offer.slots,
    // Every host unreadable is a different situation from every host busy, and a
    // visitor deserves to be told which. §Edge cases, free-busy call fails.
    unavailable:
      busy.size === 0
        ? 'Availability could not be loaded just now. Please try again in a minute, or use the contact form.'
        : null,
    problems: [...offer.problems, ...problems],
  }
}

// ---------------------------------------------------------------------------
// Confirming
// ---------------------------------------------------------------------------

export type BookInput = {
  page: BookingPageConfig
  startsAt: Date
  body: Record<string, unknown>
  attendeeTimezone: string
  attribution: {
    rawQuery?: string | null
    referrer?: string | null
    landingPage?: string | null
    pagePath?: string | null
    userAgent?: string | null
  }
  holdToken?: string | null
  rescheduleOf?: BookingRecord | null
}

export type BookOutcome =
  | { ok: true; booking: ConfirmResult }
  | { ok: false; kind: 'slot-gone' | 'invalid' | 'closed'; message: string; errors?: ConfirmResult['errors'] }

/** §4, steps 1 to 7.
 *
 *  Step 1 is the part that cannot be delegated: free-busy is re-read here with the
 *  cache bypassed, always, so a page that has been open for ten minutes cannot
 *  confirm a slot the host filled five minutes ago. */
export const book = async (input: BookInput): Promise<BookOutcome> => {
  const { page } = input
  const ctx = publicEdgeContext(page.workspaceId)

  if (!page.isActive && !input.rescheduleOf) {
    return {
      ok: false,
      kind: 'closed',
      message: 'This booking page is not taking new meetings. Please use the contact form instead.',
    }
  }

  const timezone = isKnownTimezone(input.attendeeTimezone) ? input.attendeeTimezone : 'UTC'
  const endsAt = new Date(input.startsAt.getTime() + page.durationMinutes * 60_000)
  const window = {
    from: new Date(input.startsAt.getTime() - ONE_DAY),
    to: new Date(endsAt.getTime() + ONE_DAY),
  }

  const hosts = await readPageHosts(ctx, page.bookingPageId, window)
  const { busy } = await busyForHosts(ctx, hosts, window, { bypassCache: true })

  // Only hosts whose calendar was actually read a moment ago, and who are free for
  // this exact slot on the strength of that read. Assignment happens after this,
  // never before, so a busy host is skipped rather than assigned and failed. §3.
  const free = hosts.filter((host) => {
    const external = busy.get(host.userId)
    if (!external) return false
    return !overlapsAny([...external, ...host.rawrBusy], input.startsAt, endsAt)
  })

  if (free.length === 0) {
    return {
      ok: false,
      kind: 'slot-gone',
      message: 'That slot just went. Here are the times still open.',
    }
  }

  const pending: { link: PendingLink | null } = { link: null }

  try {
    const result = await confirmBooking(
      ctx,
      {
        page,
        startsAt: input.startsAt,
        body: input.body,
        attendeeTimezone: timezone,
        attribution: input.attribution,
        holdToken: input.holdToken ?? null,
        rescheduleOf: input.rescheduleOf?.id ?? null,
      },
      free,
      provisioner(ctx, input.rescheduleOf ?? null, pending),
    )

    if (result.errors) {
      return {
        ok: false,
        kind: 'invalid',
        message: result.errors.map((error) => error.message).join(' '),
        errors: result.errors,
      }
    }
    // Committed, so the chase can start. Not awaited: the visitor is already
    // looking at their confirmation, and Zoom coming back is measured in minutes.
    if (pending.link) {
      queueConferenceBackfill({
        ...pending.link,
        workspaceId: page.workspaceId,
        bookingId: result.bookingId,
      })
    }
    return { ok: true, booking: result }
  } catch (cause) {
    if (cause instanceof SlotGoneError) {
      return { ok: false, kind: 'slot-gone', message: cause.message }
    }
    throw cause
  }
}

/** What the provisioner could not finish, read after the booking commits. The
 *  backfill needs the strings the event was written with, and only the
 *  provisioner has them. */
type PendingLink = Omit<PendingConference, 'workspaceId' | 'bookingId'>

const overlapsAny = (intervals: Interval[], start: Date, end: Date): boolean =>
  intervals.some(
    (interval) => interval.start.getTime() < end.getTime() && interval.end.getTime() > start.getTime(),
  )

/** Steps 4 and 5, called from inside the booking transaction.
 *
 *  Calendar failure throws, so nothing is written and the visitor is asked to try
 *  again: a CRM booking with no calendar event is worse than no booking. Zoom
 *  failure does not, because losing a booking over a Zoom outage is the wrong
 *  trade; the link is null, the host is told, and the event says the link is
 *  coming. */
const provisioner =
  (ctx: WorkspaceContext, moving: BookingRecord | null, pending: { link: PendingLink | null }) =>
  async (request: ProvisionRequest): Promise<Provisioned> => {
    const warnings: string[] = []
    const values = bookingTemplateValues({
      attendeeName: request.attendee.name,
      attendeeEmail: request.attendee.email,
      companyName: request.companyName,
      companyFallback: request.page.companyFallback,
      hostName: request.host.name,
      hostEmail: request.host.email,
      pageName: request.page.name,
      durationMinutes: request.page.durationMinutes,
    })

    const summary = renderTemplate(request.page.titleTpl, values)
    const bodyText = renderTemplate(request.page.descriptionTpl, values)
    const answersText = describeAnswers(request)

    const agenda = [bodyText, answersText].filter(Boolean).join('\n\n')

    let conferenceUrl: string | null = null
    let conferenceRef: string | null = null
    let zoomFailure: string | null = null

    if (request.page.location === 'zoom') {
      // A reschedule onto the same host moves the meeting it already has. Creating
      // a second one would leave the first sitting in the host's Zoom account at
      // the old time, and hand the attendee a link nobody is waiting on.
      const reusable =
        moving && moving.conferenceRef && moving.hostUserId === request.host.userId
          ? moving.conferenceRef
          : null

      const moved = reusable
        ? await updateZoomMeeting(reusable, {
            startsAt: request.startsAt,
            durationMinutes: request.page.durationMinutes,
            timezone: request.attendee.timezone,
          })
        : null

      if (moved?.ok) {
        conferenceUrl = moving?.conferenceUrl ?? null
        conferenceRef = reusable
      } else {
        const outcome = await createZoomMeeting({
          hostEmail: request.host.email,
          topic: summary,
          agenda,
          startsAt: request.startsAt,
          durationMinutes: request.page.durationMinutes,
          timezone: request.attendee.timezone,
        })
        if (outcome.ok) {
          conferenceUrl = outcome.meeting.joinUrl
          conferenceRef = outcome.meeting.meetingId
          // Only once there is a replacement: a meeting at the wrong time is worse
          // than no meeting, but not worse than losing the link entirely.
          if (reusable) await deleteZoomMeeting(reusable)
        } else {
          zoomFailure = moved ? `${moved.reason} ${outcome.reason}` : outcome.reason
          warnings.push(PENDING_NOTICE)
        }
      }
    }

    const joining =
      request.page.location === 'phone' || request.page.location === 'custom'
        ? request.page.locationDetail
        : null

    // Rawr does not send email: D7 rules out sending, and the provider that will
    // arrives in F6. The calendar invitation Google sends on our behalf is
    // therefore the only place the attendee receives their reschedule and cancel
    // links, so they go in the description rather than waiting for an ESP.
    const manage = [
      `Need a different time? ${publicBaseUrl}${bookingManagePath('reschedule', request.tokens.reschedule)}`,
      `Cannot make it? ${publicBaseUrl}${bookingManagePath('cancel', request.tokens.cancel)}`,
    ].join('\n')

    const description = [
      bodyText,
      answersText,
      conferenceUrl ? `Join: ${conferenceUrl}` : null,
      request.page.location === 'zoom' && !conferenceUrl ? PENDING_LINE : null,
      joining,
      manage,
    ]
      .filter(Boolean)
      .join('\n\n')

    if (zoomFailure) pending.link = { reason: zoomFailure, topic: summary, agenda, description }

    // Same host and an existing event: move it rather than replacing it, so the
    // attendee's calendar entry survives a reschedule instead of vanishing and
    // reappearing. A different host cannot be patched onto, so that path creates.
    if (moving && moving.calendarEventId && moving.hostUserId === request.host.userId && moving.calendarId) {
      await patchCalendarEvent(ctx, {
        userId: request.host.userId,
        calendarId: moving.calendarId,
        eventId: moving.calendarEventId,
        startsAt: request.startsAt,
        endsAt: request.endsAt,
        timezone: request.attendee.timezone,
        description,
      })
      return {
        calendarEventId: moving.calendarEventId,
        calendarId: moving.calendarId,
        conferenceUrl: conferenceUrl ?? moving.conferenceUrl,
        conferenceRef: conferenceRef ?? moving.conferenceRef,
        warnings,
      }
    }

    const event = await createCalendarEvent(ctx, {
      userId: request.host.userId,
      summary,
      description,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      timezone: request.attendee.timezone,
      attendee: { name: request.attendee.name, email: request.attendee.email },
      requestConference: request.page.location === 'google_meet',
      location: joining,
    })

    return {
      calendarEventId: event.eventId,
      calendarId: event.calendarId,
      conferenceUrl: conferenceUrl ?? event.conferenceUrl,
      conferenceRef,
      warnings,
    }
  }

/** The extra questions, on the event, so the host reads them without opening the
 *  CRM. Labels rather than keys, because `what_are_you_evaluating` is not a
 *  sentence. */
const describeAnswers = (request: ProvisionRequest): string => {
  const lines: string[] = []
  for (const field of request.page.questions) {
    const value = request.answers[field.key]
    if (value === undefined || value === null || value === '') continue
    lines.push(`${field.label}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Cancelling and rescheduling
// ---------------------------------------------------------------------------

/** §8. The calendar event goes first, because it is the thing the two people
 *  actually look at, and both halves are idempotent so clicking twice cancels
 *  once. */
export const cancelWithProviders = async (
  booking: BookingRecord,
  input: { reason?: string | null; by: 'attendee' | 'host' },
): Promise<{ alreadyDone: boolean }> => {
  const ctx = publicEdgeContext(booking.workspaceId)
  const result = await cancelBooking(ctx, booking.id, input)
  if (result.alreadyDone) return { alreadyDone: true }

  if (booking.calendarEventId && booking.calendarId) {
    await deleteCalendarEvent(ctx, {
      userId: booking.hostUserId,
      calendarId: booking.calendarId,
      eventId: booking.calendarEventId,
    }).catch(() => {
      // The booking is cancelled either way. A stale calendar entry is a visible
      // problem the host can delete; refusing the cancellation is not.
    })
  }
  if (booking.conferenceRef) await deleteZoomMeeting(booking.conferenceRef)
  return { alreadyDone: false }
}

export type RescheduleInput = {
  booking: BookingRecord
  startsAt: Date
  attendeeTimezone?: string | null
  reason?: string | null
}

/** Runs the whole availability check again, because the new time is a new question
 *  and the old answer says nothing about it. The old row becomes 'rescheduled' and
 *  the new one points back through reschedule_of, so the timeline reads as a move. */
export const rescheduleWithProviders = async (input: RescheduleInput): Promise<BookOutcome> => {
  const { booking } = input
  if (booking.state !== 'confirmed') {
    return {
      ok: false,
      kind: 'closed',
      message:
        booking.state === 'cancelled'
          ? 'That meeting was cancelled, so there is nothing to move. Book a new time instead.'
          : 'That meeting has already been rescheduled. Use the link in the newest confirmation.',
    }
  }

  const ctx = publicEdgeContext(booking.workspaceId)
  const page = await readBookingPage(ctx, booking.bookingPageId)
  if (!page) {
    return { ok: false, kind: 'closed', message: 'The page this meeting was booked on no longer exists.' }
  }

  const outcome = await book({
    page,
    startsAt: input.startsAt,
    // The answers already given are kept: a reschedule is a new time, not a new
    // questionnaire.
    body: {
      ...booking.answers,
      name: booking.attendeeName,
      email: booking.attendeeEmail,
    },
    attendeeTimezone: input.attendeeTimezone ?? booking.attendeeTimezone,
    attribution: {},
    rescheduleOf: booking,
  })

  if (!outcome.ok) return outcome

  // The new booking is committed. If it landed on a different host, the old
  // calendar event and Zoom meeting belong to nobody now, so they go. Done after
  // the commit deliberately: deleting first and then failing to insert would lose
  // a meeting that still exists in the CRM.
  if (outcome.booking.hostUserId !== booking.hostUserId) {
    if (booking.calendarEventId && booking.calendarId) {
      await deleteCalendarEvent(ctx, {
        userId: booking.hostUserId,
        calendarId: booking.calendarId,
        eventId: booking.calendarEventId,
      }).catch(() => {})
    }
    if (booking.conferenceRef) await deleteZoomMeeting(booking.conferenceRef)
  }

  return outcome
}

export type { OfferedSlot, HostAvailability }
