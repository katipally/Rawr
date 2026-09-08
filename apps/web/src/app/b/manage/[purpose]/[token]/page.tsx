import {
  bookingForToken,
  dayKey,
  isKnownTimezone,
  publicEdgeContext,
  readBookingPage,
} from '@rawr/db'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { RescheduleWidget } from '~/components/booking/reschedule-widget.tsx'
import { PendingButton } from '~/components/pending-button.tsx'
import { BOOKING_STYLES, HOSTED_BOOKING_STYLES } from '~/lib/booking-styles.ts'
import { BOOKING_COPY } from '~/lib/edge-copy.ts'
import { bookingIcsPath } from '~/lib/links.ts'
import { visitorLocale } from '~/lib/visitor-locale.ts'
import { loadOffer } from '~/server/booking.ts'
import { cancelBookingAction, rescheduleBookingAction } from './actions.ts'

/** F2 §8. What the links in an invitation open.
 *
 *  No session and no account: the token in the URL is the credential, it is single
 *  purpose, and it is not enumerable. Both actions are safe to click twice.
 *
 *  Cancelling is a plain form posting to a Server Action: one field and one button,
 *  and it works whether or not a script loaded. Moving is the same calendar the
 *  booking page uses, because picking a new time is the same question. */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Your meeting', robots: { index: false } }

const isPurpose = (value: string): value is 'cancel' | 'reschedule' =>
  value === 'cancel' || value === 'reschedule'

const HORIZON_DAYS = 21

const ManageBookingPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ purpose: string; token: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) => {
  const { purpose, token } = await params
  const query = await searchParams
  const locale = await visitorLocale()
  if (!isPurpose(purpose)) notFound()

  const single = (key: string): string | null => {
    const value = query[key]
    return typeof value === 'string' && value !== '' ? value : null
  }

  const booking = await bookingForToken(purpose, token)

  if (!booking) {
    return (
      <Shell>
        <div className="rawr-b-note" data-bad>
          <p>
            <strong>That link no longer works.</strong>
          </p>
          <p style={{ marginBlockStart: '0.5rem' }}>
            It may have been used already, or the meeting may have been moved and replaced by a newer
            invitation. Check the most recent one in your inbox, or reply to whoever you were meeting.
          </p>
        </div>
      </Shell>
    )
  }

  const timezone = isKnownTimezone(single('tz') ?? '')
    ? (single('tz') as string)
    : booking.attendeeTimezone
  const done = single('done') === '1'
  const problem = single('e')

  const when = booking.startsAt.toLocaleString(locale.tag, {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })

  const details = (
    <div className="rawr-b-panel">
      <p className="rawr-b-title">{booking.pageName}</p>
      <p style={{ marginBlockStart: '0.25rem' }}>
        {when} <span className="rawr-b-hint">({timezone})</span>
      </p>
      <p className="rawr-b-hint" style={{ marginBlockStart: '0.25rem' }}>
        With {booking.hostName} · {booking.attendeeEmail}
      </p>
      {booking.conferenceUrl && booking.state === 'confirmed' ? (
        <p style={{ marginBlockStart: '0.5rem' }}>
          <a href={booking.conferenceUrl}>Joining link</a>
        </p>
      ) : null}
      {booking.state === 'confirmed' ? (
        <p style={{ marginBlockStart: '0.5rem' }}>
          <a href={bookingIcsPath(booking.rescheduleToken)}>{BOOKING_COPY.addToCalendar}</a>
        </p>
      ) : null}
    </div>
  )

  // Idempotence, visible rather than implied: a second click lands here and says
  // the same thing as the first.
  if (booking.state === 'cancelled') {
    return (
      <Shell>
        {details}
        <div className="rawr-b-note">
          This meeting is cancelled{booking.cancelReason ? `: ${booking.cancelReason}` : '.'} Nothing
          further is needed. The calendar invitation has been withdrawn.
        </div>
      </Shell>
    )
  }

  if (booking.state === 'rescheduled') {
    return (
      <Shell>
        {details}
        <div className="rawr-b-note">
          This meeting has been moved. Use the links in the newest invitation in your inbox, which
          points at the new time.
        </div>
      </Shell>
    )
  }

  if (purpose === 'cancel') {
    return (
      <Shell>
        {details}
        {done ? (
          <div className="rawr-b-note" data-good>
            Cancelled. The calendar invitation has been withdrawn and {booking.hostName} has been told.
          </div>
        ) : (
          <form action={cancelBookingAction} className="rawr-b-form">
            <input type="hidden" name="token" value={token} />
            <div className="rawr-b-field">
              <label htmlFor="reason">Anything you want to pass on? (optional)</label>
              <input id="reason" name="reason" type="text" maxLength={500} />
            </div>
            <PendingButton className="rawr-b-cta" pendingLabel={BOOKING_COPY.cancelling}>
              Cancel this meeting
            </PendingButton>
            <p className="rawr-b-hint">
              Prefer a different time?{' '}
              <a href={`/b/manage/reschedule/${booking.rescheduleToken}`}>Move it instead</a>.
            </p>
          </form>
        )}
      </Shell>
    )
  }

  // Reschedule: the availability question is asked again from scratch, because the
  // new time is a new question and the old answer says nothing about it.
  const page = await readBookingPage(publicEdgeContext(booking.accountId), booking.bookingPageId)
  if (!page) {
    return (
      <Shell>
        {details}
        <div className="rawr-b-note" data-bad>
          The page this meeting was booked on no longer exists, so it cannot be moved from here.
          Reply to {booking.hostName} to arrange another time.
        </div>
      </Shell>
    )
  }

  if (done) {
    return (
      <Shell>
        {details}
        <div className="rawr-b-note" data-good>
          Moved. A fresh calendar invitation is on its way, and the old time has been released.
        </div>
      </Shell>
    )
  }

  const now = new Date()
  const offer = await loadOffer(page, {
    from: now,
    to: new Date(now.getTime() + HORIZON_DAYS * 86_400_000),
    now,
  })

  return (
    <Shell>
      {details}

      {problem ? (
        <div className="rawr-b-note" data-bad role="alert">
          {problem}
        </div>
      ) : null}

      {offer.unavailable ? (
        <div className="rawr-b-note" data-bad>
          {offer.unavailable}
        </div>
      ) : offer.slots.length === 0 ? (
        <div className="rawr-b-note">
          Nothing is open in the next {HORIZON_DAYS} days. Your meeting is unchanged; reply to{' '}
          {booking.hostName} to find another time.
        </div>
      ) : (
        <RescheduleWidget
          slots={offer.slots.map((slot) => slot.startsAt.toISOString())}
          timezone={timezone}
          durationMinutes={page.durationMinutes}
          token={token}
          action={rescheduleBookingAction}
          cancelHref={`/b/manage/cancel/${booking.cancelToken}`}
        />
      )}
    </Shell>
  )
}

/** The width goes on a wrapper, never on the widget element itself. The embed
 *  stylesheet declares max-width:100% on [data-rawr-booking-widget] and is
 *  unlayered, while Tailwind's utilities live in @layer utilities, so a max-w-*
 *  class on the same element silently loses and this page ran the full width of
 *  the window. The hosted booking page splits them for the same reason. */
const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="mx-auto w-full max-w-2xl p-4">
    <div data-rawr-booking-widget data-rawr-booking-hosted>
      <style dangerouslySetInnerHTML={{ __html: BOOKING_STYLES + HOSTED_BOOKING_STYLES }} />
      <div className="rawr-b">
        <div className="rawr-b-body">{children}</div>
      </div>
    </div>
  </div>
)

export default ManageBookingPage
