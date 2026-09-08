import { HOLD_MINUTES, publicBookingPage, releaseHold, renewHold } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { CORS_HEADERS, clientIp, rateLimit, readBody } from '~/server/edge.ts'

/** POST /b/:account/:slug/hold
 *
 *  A five minute soft hold, so filling in the questions does not lose the slot to
 *  somebody faster. It reserves capacity rather than the slot: on a page with three
 *  free hosts it takes three holds before an hour stops being offered, which is why
 *  a hold cannot be used to close a team's calendar.
 *
 *  A `token` in the body moves the hold that already exists rather than placing a
 *  second one. Changing your mind used to be a DELETE and a POST, which left a
 *  window holding nothing between them and cost two requests against the limit
 *  below; a refresh mid-form stacked a hold each time. One statement now, and the
 *  same token comes back.
 *
 *  DELETE still releases one outright, for somebody who closes the page. Both are
 *  best effort: a failed hold never blocks the booking, it only removes the
 *  courtesy. */

export const dynamic = 'force-dynamic'

export const OPTIONS = (): NextResponse =>
  new NextResponse(null, {
    headers: { ...CORS_HEADERS, 'access-control-allow-methods': 'POST, DELETE, OPTIONS' },
  })

export const POST = async (
  request: NextRequest,
  { params }: { params: Promise<{ account: string; slug: string }> },
): Promise<NextResponse> => {
  const { account, slug } = await params
  const summary = await publicBookingPage(account, slug)
  if (!summary || !summary.isActive) {
    return NextResponse.json(
      { error: 'That booking page is not taking meetings.' },
      { status: 404, headers: CORS_HEADERS },
    )
  }

  // Cheap, but a hold consumes capacity, so a script must not be able to place
  // thousands and empty the calendar. Five a minute is more than a person needs.
  const limit = rateLimit(`bh:${summary.bookingPageId}:${clientIp(request) ?? 'unknown'}`, 5, 60)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many holds from here. Confirm the time you picked, or try again shortly.' },
      { status: 429, headers: { ...CORS_HEADERS, 'retry-after': String(limit.retryAfterSeconds) } },
    )
  }

  const body = await readBody(request)
  const slot = typeof body.slot === 'string' ? new Date(body.slot) : new Date(Number.NaN)
  if (Number.isNaN(slot.getTime())) {
    return NextResponse.json(
      { error: 'That time could not be read.' },
      { status: 400, headers: CORS_HEADERS },
    )
  }

  const token = typeof body.token === 'string' ? body.token : null
  const held = await renewHold(summary.accountId, summary.bookingPageId, slot, token)
  return NextResponse.json(
    { token: held.token, expiresAt: held.expiresAt.toISOString(), minutes: HOLD_MINUTES },
    { headers: CORS_HEADERS },
  )
}

export const DELETE = async (
  request: NextRequest,
  { params }: { params: Promise<{ account: string; slug: string }> },
): Promise<NextResponse> => {
  const { account, slug } = await params
  const summary = await publicBookingPage(account, slug)
  if (!summary) return new NextResponse(null, { status: 204, headers: CORS_HEADERS })

  const token = request.nextUrl.searchParams.get('token')
  // Released by token alone: it is unguessable, and releasing somebody else's hold
  // only gives a slot back rather than taking one away.
  if (token) await releaseHold(summary.accountId, token)
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}
