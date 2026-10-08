import type { BookingPageConfig, ConfirmResult } from '@rawr/db'
import { publicBaseUrl } from '~/lib/env.ts'
import { bookingIcsPath, bookingManagePath, bookingPublicPath } from '~/lib/links.ts'
import { whereLine } from './booking-mail.ts'

type ConfirmedBooking = Pick<
  ConfirmResult,
  'startsAt' | 'endsAt' | 'hostName' | 'conferenceUrl' | 'rescheduleToken' | 'cancelToken' | 'warnings'
>
type ConfirmedPage = Pick<BookingPageConfig, 'location' | 'locationDetail' | 'redirectUrl' | 'confirmationCopy'>

/** The JSON the script embed reads back after a booking. */
export const confirmationBody = (
  account: string,
  slug: string,
  page: ConfirmedPage,
  booking: ConfirmedBooking,
) => ({
  startsAt: booking.startsAt.toISOString(),
  endsAt: booking.endsAt.toISOString(),
  hostName: booking.hostName,
  conferenceUrl: booking.conferenceUrl,
  /** The place as the mail and the calendar file say it. */
  where: whereLine(page, booking.conferenceUrl),
  rescheduleUrl: `${publicBaseUrl}${bookingManagePath('reschedule', booking.rescheduleToken)}`,
  /** For a calendar that is not the mailbox Google invited. */
  calendarUrl: `${publicBaseUrl}${bookingIcsPath(booking.rescheduleToken)}`,
  cancelUrl: `${publicBaseUrl}${bookingManagePath('cancel', booking.cancelToken)}`,
  /** Where to send somebody whose script then fails. Same booking, shown by the hosted page. */
  confirmationUrl: `${publicBaseUrl}${bookingPublicPath(account, slug, {
    confirmed: '1',
    r: booking.rescheduleToken,
  })}`,
  /** A Zoom outage does not fail a booking; it lands here so the embed can say
   *  the link is coming rather than pretending there is one. */
  warnings: booking.warnings,
  redirectUrl: page.redirectUrl,
  message: page.confirmationCopy,
})
