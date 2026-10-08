import { publicBookingPage, publicEdgeContext, readBookingPage } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { localeFrom } from '~/lib/format.ts'
import { confirmationBody } from '~/server/booking-confirm.ts'
import { book } from '~/server/booking.ts'
import { CORS_HEADERS, bodyRefusal, clientIp, rateLimit, readBody } from '~/server/edge.ts'

/** POST /b/:account/:slug/confirm
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
  { params }: { params: Promise<{ account: string; slug: string }> },
): Promise<NextResponse> => {
  const { account, slug } = await params
  const summary = await publicBookingPage(account, slug)
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

  let body: Record<string, unknown>
  try {
    body = await readBody(request)
  } catch (cause) {
    const { error, status } = bodyRefusal(cause)
    return NextResponse.json({ error }, { status, headers: CORS_HEADERS })
  }
  const startsAt = typeof body.slot === 'string' ? new Date(body.slot) : new Date(Number.NaN)
  if (Number.isNaN(startsAt.getTime())) {
    return NextResponse.json(
      { error: 'That time could not be read. Pick one from the list.' },
      { status: 400, headers: CORS_HEADERS },
    )
  }

  const page = await readBookingPage(publicEdgeContext(summary.accountId), summary.bookingPageId)
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
    attendeeLocale: localeFrom(request.headers.get('accept-language')),
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

  return NextResponse.json(
    confirmationBody(account, slug, page, outcome.booking),
    { headers: CORS_HEADERS },
  )
}
