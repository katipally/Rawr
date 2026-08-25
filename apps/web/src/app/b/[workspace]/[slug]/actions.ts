'use server'

import { publicBookingPage, publicEdgeContext, readBookingPage } from '@rawr/db'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { bookingPublicPath } from '~/lib/links.ts'
import { book } from '~/server/booking.ts'
import { rateLimit } from '~/server/edge.ts'

/** The no-JavaScript confirm path, and the one the enhanced page uses too.
 *
 *  A Server Action rather than a route handler, because Next posts this form as
 *  plain HTTP when no script has loaded, and the same code then covers both cases.
 *
 *  Everything comes back through the URL on a redirect: per-field errors, the slot,
 *  the month. A redirect rather than a re-render is what stops a refresh from
 *  booking a second meeting. */

export const confirmHostedBooking = async (data: FormData): Promise<void> => {
  const workspace = String(data.get('rawr_workspace') ?? '')
  const slug = String(data.get('rawr_slug') ?? '')
  const slot = String(data.get('rawr_slot') ?? '')
  const timezone = String(data.get('rawr_tz') ?? 'UTC')
  const month = String(data.get('rawr_month') ?? '')
  const date = String(data.get('rawr_date') ?? '')

  const where = (extra: Record<string, string | undefined>): string =>
    bookingPublicPath(workspace, slug, {
      tz: timezone,
      month: month || undefined,
      date: date || undefined,
      ...extra,
    })

  const startsAt = new Date(slot)
  if (Number.isNaN(startsAt.getTime())) {
    redirect(where({ e: 'That time could not be read. Pick one from the list.' }))
  }

  const summary = await publicBookingPage(workspace, slug)
  if (!summary) {
    redirect(where({ e: 'That booking page no longer exists.' }))
  }

  const incoming = await headers()
  const ip =
    incoming.get('x-forwarded-for')?.split(',')[0]?.trim() ?? incoming.get('x-real-ip') ?? null

  // Booking is expensive: it reads free-busy for every host and writes a calendar
  // event. Ten attempts a minute from one address is far more than a person needs
  // and far less than a script wants.
  const limit = rateLimit(`b:${summary.bookingPageId}:${ip ?? 'unknown'}`, 10, 60)
  if (!limit.allowed) {
    redirect(
      where({
        e: `That was sent too quickly. Try again in ${limit.retryAfterSeconds} seconds; nothing was booked twice.`,
      }),
    )
  }

  const ctx = publicEdgeContext(summary.workspaceId)
  const page = await readBookingPage(ctx, summary.bookingPageId)
  if (!page) {
    redirect(where({ e: 'That booking page no longer exists.' }))
  }

  const body: Record<string, unknown> = {}
  for (const key of new Set(data.keys())) {
    if (key.startsWith('rawr_')) continue
    // Next posts its own action id in the same FormData. The validator refuses any
    // answer to a question the page does not ask, and would refuse that one first.
    if (key.startsWith('$')) continue
    const all = data.getAll(key).map((value) => String(value))
    body[key] = all.length > 1 ? all : (all[0] ?? '')
  }

  const outcome = await book({
    page,
    startsAt,
    body,
    attendeeTimezone: timezone,
    attribution: {
      referrer: incoming.get('referer'),
      pagePath: `/b/${workspace}/${slug}`,
      userAgent: incoming.get('user-agent'),
    },
    holdToken: typeof data.get('rawr_hold') === 'string' ? String(data.get('rawr_hold')) : null,
  })

  if (!outcome.ok) {
    if (outcome.kind === 'invalid' && outcome.errors?.length) {
      const errors: Record<string, string> = {}
      for (const error of outcome.errors) errors[error.key] = error.message
      redirect(where({ err: JSON.stringify(errors), slot }))
    }
    // A slot that has gone is not an error the person caused, so the message says
    // what happened and the list they land on is current.
    redirect(where({ e: outcome.message }))
  }

  const confirmedAt = outcome.booking.startsAt.toISOString()
  redirect(
    bookingPublicPath(workspace, slug, {
      tz: timezone,
      confirmed: '1',
      at: confirmedAt,
      r: outcome.booking.rescheduleToken,
      c: outcome.booking.cancelToken,
      // Only the first: the confirmation is a reassurance, not a status page, and
      // every warning the provisioner raises is already written down for the host.
      w: outcome.booking.warnings[0],
    }),
  )
}
