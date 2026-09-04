import { publicBookingPage, publicEdgeContext, readBookingPage } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { publicBaseUrl } from '~/lib/env.ts'
import { bookingIcsPath, bookingManagePath, bookingPublicPath } from '~/lib/links.ts'
import { book } from '~/server/booking.ts'
import { CORS_HEADERS, clientIp, rateLimit, readBody } from '~/server/edge.ts'

/** POST /b/:workspace/:slug/confirm
 *
 *  The JSON confirmation, for the script embed. The hosted page uses a Server
 *  Action; both run the same `book()` behind them, so the two cannot drift on
 *  assignment, on what is written, or on what happens when Zoom is down.
 *
 *  A slot that has gone answers 409 with the message the visitor should read, so
 *  the embed can refresh its list rather than showing a failure. */

export const dynamic = 'force-dynamic'

export const OPTIONS = (): NextResponse => new NextResponse(null, { headers: CORS_HEADERS })

export const POST = async (
  request: NextRequest,
  { params }: { params: Promise<{ workspace: string; slug: string }> },
): Promise<NextResponse> => {
  const { workspace, slug } = await params
  const summary = await publicBookingPage(workspace, slug)
  if (!summary) {
    return NextResponse.json(
      { error: 'There is no booking page at that address.' },
      { status: 404, headers: CORS_HEADERS },
    )
  }

  const limit = rateLimit(`b:${summary.bookingPageId}:${clientIp(request) ?? 'unknown'}`, 10, 60)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `That was sent too quickly. Try again in ${limit.retryAfterSeconds} seconds.` },
      { status: 429, headers: { ...CORS_HEADERS, 'retry-after': String(limit.retryAfterSeconds) } },
    )
  }

  const body = await readBody(request)
  const startsAt = typeof body.slot === 'string' ? new Date(body.slot) : new Date(Number.NaN)
  if (Number.isNaN(startsAt.getTime())) {
    return NextResponse.json(
      { error: 'That time could not be read. Pick one from the list.' },
      { status: 400, headers: CORS_HEADERS },
    )
  }

  const page = await readBookingPage(publicEdgeContext(summary.workspaceId), summary.bookingPageId)
  if (!page) {
    return NextResponse.json(
      { error: 'That booking page no longer exists.' },
      { status: 404, headers: CORS_HEADERS },
    )
  }

  const answers: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    // Transport, not answers. The validator refuses anything the page did not ask.
    if (key === 'slot' || key === 'timezone' || key === 'hold' || key === 'pagePath') continue
    if (key === 'vid') continue
    answers[key] = value
  }

  const outcome = await book({
    page,
    startsAt,
    body: answers,
    attendeeTimezone: typeof body.timezone === 'string' ? body.timezone : 'UTC',
    attribution: {
      referrer: request.headers.get('referer'),
      pagePath: typeof body.pagePath === 'string' ? body.pagePath : null,
      userAgent: request.headers.get('user-agent'),
    },
    holdToken: typeof body.hold === 'string' ? body.hold : null,
    visitorId: typeof body.vid === 'string' ? body.vid : null,
  })

  if (!outcome.ok) {
    const status = outcome.kind === 'slot-gone' ? 409 : outcome.kind === 'closed' ? 410 : 422
    return NextResponse.json(
      {
        error: outcome.message,
        kind: outcome.kind,
        ...(outcome.errors ? { fields: outcome.errors } : {}),
      },
      { status, headers: CORS_HEADERS },
    )
  }

  const booking = outcome.booking
  return NextResponse.json(
    {
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      hostName: booking.hostName,
      conferenceUrl: booking.conferenceUrl,
      rescheduleUrl: `${publicBaseUrl}${bookingManagePath('reschedule', booking.rescheduleToken)}`,
      /** For a calendar that is not the mailbox Google invited. */
      calendarUrl: `${publicBaseUrl}${bookingIcsPath(booking.rescheduleToken)}`,
      cancelUrl: `${publicBaseUrl}${bookingManagePath('cancel', booking.cancelToken)}`,
      /** Where to send somebody whose script then fails. Same booking, shown by
       *  the hosted page. */
      confirmationUrl: `${publicBaseUrl}${bookingPublicPath(workspace, slug, {
        confirmed: '1',
        at: booking.startsAt.toISOString(),
        r: booking.rescheduleToken,
        c: booking.cancelToken,
      })}`,
      /** A Zoom outage does not fail a booking; it lands here so the embed can say
       *  the link is coming rather than pretending there is one. */
      warnings: booking.warnings,
      redirectUrl: page.redirectUrl,
      message: page.confirmationCopy,
    },
    { headers: CORS_HEADERS },
  )
}
