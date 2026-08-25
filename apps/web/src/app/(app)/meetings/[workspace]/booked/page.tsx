import { listBookingPages, listBookings } from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { bookedPath, bookingPagesPath, recordPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { BookedRow } from './booked-row.tsx'

/** Every meeting booked through Rawr. Upcoming first, because that is what a
 *  person opening this screen wants.
 *
 *  Every control is in the URL, so a filtered view pastes into Slack and opens the
 *  same way for whoever clicks it. */

const isWhen = (value: string | undefined): value is 'upcoming' | 'past' =>
  value === 'upcoming' || value === 'past'

const isState = (value: string | undefined): value is 'confirmed' | 'cancelled' | 'rescheduled' =>
  value === 'confirmed' || value === 'cancelled' || value === 'rescheduled'

const BookedScreen = async ({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ when?: string; page?: string; host?: string; state?: string }>
}) => {
  const { workspace } = await params
  const query = await searchParams
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  const when = isWhen(query.when) ? query.when : 'upcoming'

  const [pages, result] = await Promise.all([
    listBookingPages(ctx),
    listBookings(ctx, {
      when,
      pageId: query.page ?? null,
      state: isState(query.state) ? query.state : null,
      hostUserId: query.host ?? null,
    }),
  ])

  const pageName = pages.find((page) => page.id === query.page)?.name

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <header className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <h1 className="text-lg font-medium">Booked meetings</h1>
        {pageName ? <span className="text-sm text-secondary">{pageName}</span> : null}
        <Link href={bookingPagesPath(workspace)} className="ml-auto text-sm font-semibold text-link">
          Meeting links
        </Link>
      </header>

      <nav className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {(['upcoming', 'past'] as const).map((option) => (
          <Link
            key={option}
            href={bookedPath(workspace, { ...query, when: option } as never)}
            aria-current={when === option ? 'page' : undefined}
            className={
              when === option
                ? 'rounded-hs bg-accent-subtle px-2 py-0.5 font-semibold text-link no-underline'
                : 'rounded-hs px-2 py-0.5 no-underline hover:bg-fill-hover'
            }
          >
            {option === 'upcoming' ? 'Upcoming' : 'Past'}
          </Link>
        ))}

        {query.page ? (
          <Link href={bookedPath(workspace, { when })} className="text-link">
            Clear page filter
          </Link>
        ) : null}
      </nav>

      {result.rows.length === 0 ? (
        <EmptyState
          title={when === 'upcoming' ? 'Nothing booked yet' : 'No past meetings'}
          description={
            when === 'upcoming'
              ? 'A meeting booked through a page shows up here, and on the contact’s timeline.'
              : 'Meetings move here once they have happened.'
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {result.rows.map((booking) => (
            <BookedRow
              key={booking.id}
              booking={{
                id: booking.id,
                pageName: booking.pageName,
                hostName: booking.hostName,
                attendeeName: booking.attendeeName,
                attendeeEmail: booking.attendeeEmail,
                startsAt: booking.startsAt.toISOString(),
                endsAt: booking.endsAt.toISOString(),
                state: booking.state,
                conferenceUrl: booking.conferenceUrl,
              }}
              contactHref={
                booking.contactId ? recordPath(workspace, 'contact', booking.contactId) : null
              }
              editable={session.role === 'admin' || session.role === 'sales'}
            />
          ))}
        </ul>
      )}

      {result.nextCursor ? (
        <p className="mt-3 text-xs text-secondary">
          Showing the first {result.rows.length}. Narrow by page or by upcoming and past to see more.
        </p>
      ) : null}
    </div>
  )
}

export default BookedScreen
