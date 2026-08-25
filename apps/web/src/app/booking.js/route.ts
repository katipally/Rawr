import { NextResponse } from 'next/server'
import { BOOKING_STYLES } from '~/lib/booking-styles.ts'
import { publicBaseUrl } from '~/lib/env.ts'
import { buildBookingScript } from '~/server/booking-script.ts'

/** GET /booking.js — the one file a Webflow page loads to render the widget.
 *
 *  Built per request because it carries the public base URL, which is environment
 *  rather than code. It is small and cached, so building it costs nothing
 *  measurable. */

export const GET = (): NextResponse => {
  const script = buildBookingScript({ baseUrl: publicBaseUrl, styles: BOOKING_STYLES })

  return new NextResponse(script, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      // Longer than the form embed's five minutes: nothing here is versioned
      // against a policy that has to reach every visitor within the hour.
      'cache-control': 'public, max-age=1800, stale-while-revalidate=86400',
      'access-control-allow-origin': '*',
    },
  })
}
