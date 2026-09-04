import {
  dayKey,
  isKnownTimezone,
  publicBookingPage,
  publicEdgeContext,
  readBookingPage,
  zonedTimeToUtc,
} from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { CORS_HEADERS, clientIp, rateLimit } from '~/server/edge.ts'
import { loadOffer, nextAvailableAfter } from '~/server/booking.ts'

/** GET /b/:workspace/:slug/slots?month=YYYY-MM&tz=Area/City
 *
 *  What the embed reads. The hosted page does not need it: it renders its own
 *  months server side. This exists so the script embed can change month without a
 *  navigation, and so the page can refresh a stale list after a slot goes.
 *
 *  Returns instants and counts. Never a host name, never a reason a host is
 *  unavailable: those name staff, and this endpoint answers to anybody. */

export const dynamic = 'force-dynamic'

export const OPTIONS = (): NextResponse => new NextResponse(null, { headers: CORS_HEADERS })

export const GET = async (
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

  // Availability costs a free-busy read per host. Generous for a person clicking
  // through months, tight enough that scraping every month of every page is not
  // free.
  const limit = rateLimit(`bs:${summary.bookingPageId}:${clientIp(request) ?? 'unknown'}`, 60, 60)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${limit.retryAfterSeconds} seconds.` },
      { status: 429, headers: { ...CORS_HEADERS, 'retry-after': String(limit.retryAfterSeconds) } },
    )
  }

  const url = request.nextUrl
  const requestedZone = url.searchParams.get('tz') ?? ''
  const timezone = isKnownTimezone(requestedZone) ? requestedZone : 'UTC'
  const now = new Date()
  const requestedMonth = url.searchParams.get('month') ?? ''
  const monthKey = /^\d{4}-\d{2}$/.test(requestedMonth)
    ? requestedMonth
    : dayKey(now, timezone).slice(0, 7)

  const [year = 1970, month = 1] = monthKey.split('-').map(Number)
  const nextMonth = new Date(Date.UTC(year, month, 1))
  const from = zonedTimeToUtc(`${monthKey}-01`, 0, timezone)
  const to = zonedTimeToUtc(
    `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}-01`,
    0,
    timezone,
  )

  const page = await readBookingPage(publicEdgeContext(summary.workspaceId), summary.bookingPageId)
  if (!page || !page.isActive) {
    return NextResponse.json(
      {
        month: monthKey,
        timezone,
        slots: [],
        unavailable: 'This page is not taking new meetings at the moment.',
      },
      { headers: CORS_HEADERS },
    )
  }

  const offer = await loadOffer(page, { from, to, now })

  // An empty month is the one moment somebody needs to be told where to click.
  // Only when availability was actually established: "nothing until December" is a
  // lie when the truth is that no calendar could be read.
  const nextAvailable =
    offer.slots.length === 0 && !offer.unavailable ? await nextAvailableAfter(page, to) : null

  return NextResponse.json(
    {
      month: monthKey,
      nextAvailable: nextAvailable ? nextAvailable.toISOString() : null,
      timezone,
      name: page.name,
      organisation: page.workspaceName,
      location: page.location,
      durationMinutes: page.durationMinutes,
      /** The questions to ask, so the embed renders the same form the hosted page
       *  does from the same source rather than a copy that drifts. Already public:
       *  anybody can read them off the hosted page. */
      questions: page.questions.map((field) => ({
        key: field.key,
        type: field.type,
        label: field.label,
        required: field.required,
        placeholder: field.placeholder ?? null,
        options: field.options ?? null,
      })),
      slots: offer.slots.map((slot) => ({
        startsAt: slot.startsAt.toISOString(),
        /** How many hosts could take it. A visitor does not need to know who, but
         *  the embed uses it to keep a slot on screen when a hold is placed. */
        capacity: slot.hostUserIds.length,
      })),
      unavailable: offer.unavailable,
    },
    {
      headers: {
        ...CORS_HEADERS,
        // The server-side free-busy cache is sixty seconds; matching it here means
        // a reload inside that window costs nothing and is no more stale.
        'cache-control': 'private, max-age=30',
      },
    },
  )
}
