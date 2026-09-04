import {
  bookingForToken,
  dayKey,
  isKnownTimezone,
  publicEdgeContext,
  readBookingPage,
} from '@rawr/db'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PendingButton } from '~/components/pending-button.tsx'
import { BOOKING_STYLES, HOSTED_BOOKING_STYLES } from '~/lib/booking-styles.ts'
import { BOOKING_COPY, hourIn, slotBandOf } from '~/lib/edge-copy.ts'
import { bookingIcsPath } from '~/lib/links.ts'
import { visitorLocale } from '~/lib/visitor-locale.ts'
import { loadOffer } from '~/server/booking.ts'
import { cancelBookingAction, rescheduleBookingAction } from './actions.ts'

/** F2 §8. What the links in an invitation open.
 *
 *  No session and no account: the token in the URL is the credential, it is single
 *  purpose, and it is not enumerable. Both actions are safe to click twice.
 *
 *  Server rendered with plain forms, because this is a link in an email opened on a
 *  phone on a train, and it has to work when a script does not load. */

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
  const page = await readBookingPage(publicEdgeContext(booking.workspaceId), booking.bookingPageId)
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

  const byDay = new Map<string, Date[]>()
  for (const slot of offer.slots) {
    const key = dayKey(slot.startsAt, timezone)
    const list = byDay.get(key) ?? []
    list.push(slot.startsAt)
    byDay.set(key, list)
  }

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
      ) : byDay.size === 0 ? (
        <div className="rawr-b-note">
          Nothing is open in the next {HORIZON_DAYS} days. Your meeting is unchanged; reply to{' '}
          {booking.hostName} to find another time.
        </div>
      ) : (
        <form action={rescheduleBookingAction} className="rawr-b-form">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="tz" value={timezone} />

          <p>Pick a new time. Times are shown in {timezone}.</p>

          {[...byDay.entries()].map(([day, slots]) => (
            <fieldset key={day} style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="rawr-b-hint" style={{ paddingBlockEnd: '0.25rem' }}>
                {new Date(`${day}T12:00:00Z`).toLocaleDateString(locale.tag, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                })}
              </legend>
              {/* Banded the way the booking page bands them. Three weeks of
                  half-hour slots is several hundred radio buttons on one page,
                  which is what a form that has to work without JavaScript costs;
                  naming the runs is what makes it scannable anyway. */}
              {bandsOf(slots, timezone).map(([band, run]) => (
                <div key={band} className="rawr-b-band">
                  <p className="rawr-b-bandname">{band}</p>
                  <div className="rawr-b-times">
                    {run.map((slot) => {
                      const iso = slot.toISOString()
                      return (
                        <label key={iso} className="rawr-b-slot">
                          <input
                            type="radio"
                            name="slot"
                            value={iso}
                            required
                            style={{ marginInlineEnd: '0.375rem' }}
                          />
                          {slot.toLocaleTimeString(locale.tag, {
                            timeZone: timezone,
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </label>
                      )
                    })}
                  </div>
                </div>
              ))}
            </fieldset>
          ))}

          <PendingButton className="rawr-b-cta" pendingLabel={BOOKING_COPY.moving}>
            Move my meeting
          </PendingButton>
          <p className="rawr-b-hint">
            Would rather not meet at all? <a href={`/b/manage/cancel/${booking.cancelToken}`}>Cancel</a>.
          </p>
        </form>
      )}
    </Shell>
  )
}

/** The day's times split into the runs a person reads them in. Insertion order is
 *  preserved by Map, and the slots arrive sorted. */
const bandsOf = (slots: Date[], timezone: string): [string, Date[]][] => {
  const bands = new Map<string, Date[]>()
  for (const slot of slots) {
    const band = slotBandOf(hourIn(slot, timezone))
    const list = bands.get(band)
    if (list) list.push(slot)
    else bands.set(band, [slot])
  }
  return [...bands]
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
      <div className="rawr-b">{children}</div>
    </div>
  </div>
)

export default ManageBookingPage
