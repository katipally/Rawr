import {
  bookingFields,
  dayKey,
  isKnownTimezone,
  publicBookingPage,
  publicEdgeContext,
  readBookingPage,
  zonedTimeToUtc,
  type PublicBookingPage,
} from '@rawr/db'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { BookingWidget } from '~/components/booking/booking-widget.tsx'
import { EmbedHeight } from '~/components/booking/embed-height.tsx'
import { BOOKING_STYLES, HOSTED_BOOKING_STYLES } from '~/lib/booking-styles.ts'
import { BOOKING_COPY } from '~/lib/edge-copy.ts'
import { bookingIcsPath } from '~/lib/links.ts'
import { loadOffer, nextAvailableAfter } from '~/server/booking.ts'

/** The public booking page. F2 §4 and §7.
 *
 *  A server shell around one client widget. The month is resolved here so the first
 *  paint is a calendar rather than a spinner, and every step after that is state in
 *  the browser: no navigation between picking a day and picking a time, which is
 *  what four page loads used to cost.
 *
 *  The same route is the embed. `?embed=1` drops the page furniture and reports its
 *  height to the frame around it, so marketing pastes one line into Webflow and gets
 *  this, rather than a second implementation that drifts from this one. */

export const dynamic = 'force-dynamic'

export const generateMetadata = async ({
  params,
}: {
  params: Promise<{ account: string; slug: string }>
}): Promise<Metadata> => {
  const { account, slug } = await params
  const page = await publicBookingPage(account, slug)
  // The page's own name, not "Book " plus it: pages are usually already named for
  // the action ("Book time with me"), and prefixing produced "Book Book time with
  // me" in the browser tab.
  return {
    title: page ? `${page.name} · ${page.accountName}` : 'Book a meeting',
    robots: { index: false },
  }
}

const nextMonthKey = (monthKey: string, by: number): string => {
  const [year = 1970, month = 1] = monthKey.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1 + by, 1))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

const BookingPublicPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) => {
  const { account, slug } = await params
  const query = await searchParams
  const single = (key: string): string | null => {
    const value = query[key]
    return typeof value === 'string' && value !== '' ? value : null
  }
  const embedded = single('embed') === '1'

  const summary = await publicBookingPage(account, slug)
  if (!summary) notFound()

  // The widget needs the questions and the confirmation copy, which the public
  // resolver deliberately does not return. Reading them takes a account scope,
  // and by this point the slug has named one.
  const page = await readBookingPage(publicEdgeContext(summary.accountId), summary.bookingPageId)
  if (!page) notFound()

  // A booking confirmed through the JSON endpoint by a script that then failed
  // lands here. Rare, and the one moment somebody needs to be told the meeting is
  // real, so it is answered from the URL rather than left to a widget that is
  // evidently not running.
  if (single('confirmed') === '1') {
    return (
      <Shell page={summary} embedded={embedded}>
        <div className="rawr-b">
          <div className="rawr-b-body">
            <p className="rawr-b-note" data-good>
              <strong>{BOOKING_COPY.booked}</strong>{' '}
              {page.confirmationCopy ??
                'A calendar invitation is on its way to your inbox, with the joining details and links to move or cancel the meeting.'}
            </p>
            <p className="rawr-b-actions">
              {single('r') ? (
                <>
                  <a className="rawr-b-link" href={bookingIcsPath(single('r') as string)}>
                    {BOOKING_COPY.addToCalendar}
                  </a>
                  <a className="rawr-b-link" href={`/b/manage/reschedule/${single('r')}`}>
                    {BOOKING_COPY.reschedule}
                  </a>
                </>
              ) : null}
              {single('c') ? (
                <a className="rawr-b-link" href={`/b/manage/cancel/${single('c')}`}>
                  {BOOKING_COPY.cancel}
                </a>
              ) : null}
            </p>
          </div>
        </div>
      </Shell>
    )
  }

  if (!page.isActive) {
    return (
      <Shell page={summary} embedded={embedded}>
        <div className="rawr-b">
          <div className="rawr-b-body">
            <p className="rawr-b-note" data-bad>
              This page is not taking new meetings at the moment. Existing bookings still stand, and
              the reschedule link in your invitation still works.
            </p>
          </div>
        </div>
      </Shell>
    )
  }

  // The server cannot know a browser's timezone, so the first month is resolved in
  // UTC and the widget re-reads it in the visitor's own zone on mount. That costs
  // one request and buys a first paint with a real calendar in it.
  const timezone = isKnownTimezone(single('tz') ?? '') ? (single('tz') as string) : 'UTC'
  const now = new Date()
  const requested = single('month')
  const monthKey = /^\d{4}-\d{2}$/.test(requested ?? '')
    ? (requested as string)
    : dayKey(now, timezone).slice(0, 7)

  const from = zonedTimeToUtc(`${monthKey}-01`, 0, timezone)
  const to = zonedTimeToUtc(`${nextMonthKey(monthKey, 1)}-01`, 0, timezone)
  const offer = await loadOffer(page, { from, to, now })

  // Only when the month is genuinely empty and availability was actually
  // established: "nothing until December" is a lie when the truth is that no
  // calendar could be read.
  const nextOpen =
    offer.slots.length === 0 && !offer.unavailable ? await nextAvailableAfter(page, to) : null

  return (
    <Shell page={summary} embedded={embedded}>
      <BookingWidget
        page={{
          account,
          slug,
          name: page.name,
          organisation: page.accountName,
          hostNames: page.hostNames,
          durationMinutes: page.durationMinutes,
          location: page.location,
          fields: bookingFields(page.questions),
          confirmationCopy: page.confirmationCopy,
          redirectUrl: page.redirectUrl,
        }}
        initial={{
          month: monthKey,
          timezone,
          slots: offer.slots.map((slot) => ({
            startsAt: slot.startsAt.toISOString(),
            capacity: slot.hostUserIds.length,
          })),
          unavailable: offer.unavailable,
          nextAvailable: nextOpen ? nextOpen.toISOString() : null,
        }}
      />
    </Shell>
  )
}

const Shell = ({
  page,
  embedded,
  children,
}: {
  page: PublicBookingPage
  /** Inside somebody else's page, in a frame. No margins of ours, and the height
   *  is reported outwards so the frame can size itself to the widget. */
  embedded: boolean
  children: React.ReactNode
}) => (
  // The page width is set on a wrapper rather than on the widget itself. The embed
  // stylesheet declares max-width:100% on [data-rawr-booking-widget], and that rule
  // is unlayered while Tailwind's utilities live in @layer utilities, so a max-w-*
  // class on the same element silently loses. Keeping the two on separate elements
  // means neither has to know about the other, and the embed CSS stays unlayered
  // where it belongs: inside somebody else's page it must beat their stylesheet.
  <div className={embedded ? 'w-full' : 'mx-auto w-full max-w-4xl p-4'}>
    <div data-rawr-booking-widget data-rawr-booking-hosted>
      <style dangerouslySetInnerHTML={{ __html: BOOKING_STYLES + HOSTED_BOOKING_STYLES }} />
      {children}
    </div>
    {embedded ? <EmbedHeight title={page.name} /> : null}
  </div>
)

export default BookingPublicPage
