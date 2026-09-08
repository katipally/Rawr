import { listBookingPages, listBookings, listMembers } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { MeetingsTabs } from '../tabs.tsx'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { bookedPath, recordPath } from '~/lib/links.ts'
import { contextFrom, readSession, sessionCanEdit } from '~/server/session.ts'
import { BookedList } from './booked-list.tsx'

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
  params: Promise<{ account: string }>
  searchParams: Promise<{ when?: string; page?: string; host?: string; state?: string }>
}) => {
  const { account } = await params
  const query = await searchParams
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  const when = isWhen(query.when) ? query.when : 'upcoming'

  const filters = {
    when,
    page: query.page ?? null,
    host: query.host ?? null,
    state: isState(query.state) ? query.state : null,
  }

  const [pages, members, result] = await Promise.all([
    listBookingPages(ctx),
    listMembers(ctx),
    listBookings(ctx, {
      when,
      pageId: filters.page,
      state: filters.state,
      hostUserId: filters.host,
    }),
  ])

  const pageName = pages.find((page) => page.id === query.page)?.name

  return (
    <div className="w-full max-w-6xl">
      <PageHeader
        className="mb-4"
        title="Booked meetings"
        lead={pageName ?? 'Everything anybody booked, on every page.'}
      />

      <MeetingsTabs account={account} current="booked" />

      <nav className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {(['upcoming', 'past'] as const).map((option) => (
          <Link
            key={option}
            href={bookedPath(account, { ...query, when: option } as never)}
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
      ) : null}

      {/* Keyed on the filters: the list holds the pages it has fetched, and a
          new filter is a new list rather than more of the old one. */}
      <BookedList
        key={`${when}:${filters.page}:${filters.host}:${filters.state}`}
        account={account}
        query={filters}
        pages={pages.map((page) => ({ id: page.id, name: page.name }))}
        hosts={members.map((member) => ({ id: member.userId, name: member.name }))}
        initialRows={result.rows.map((booking) => ({
          id: booking.id,
          pageName: booking.pageName,
          hostName: booking.hostName,
          attendeeName: booking.attendeeName,
          attendeeEmail: booking.attendeeEmail,
          startsAt: booking.startsAt.toISOString(),
          endsAt: booking.endsAt.toISOString(),
          state: booking.state,
          conferenceUrl: booking.conferenceUrl,
        }))}
        initialCursor={
          result.nextCursor
            ? { startsAt: result.nextCursor.startsAt.toISOString(), id: result.nextCursor.id }
            : null
        }
        contactHrefs={Object.fromEntries(
          result.rows.flatMap((booking) =>
            booking.contactId ? [[booking.id, recordPath(account, 'contact', booking.contactId)]] : [],
          ),
        )}
        editable={sessionCanEdit(session, 'sales')}
      />
    </div>
  )
}

export default BookedScreen
