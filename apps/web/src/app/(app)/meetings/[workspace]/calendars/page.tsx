import { listGrants } from '@rawr/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { devCalendarEnabled, googleCalendarConfigured } from '~/lib/env.ts'
import { availabilityPath, bookingPagesPath } from '~/lib/links.ts'
import { readLookups } from '~/server/crm.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { CalendarRow } from './calendar-row.tsx'

/** Who has a working calendar, and what is wrong with the ones that do not.
 *
 *  This screen exists because a host without a calendar is silently unavailable
 *  everywhere: no error, just an empty booking page. The health state has to be
 *  visible somewhere, with the real reason on it. F2 §Edge cases. */

const CalendarsScreen = async ({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ error?: string }>
}) => {
  const { workspace } = await params
  const { error } = await searchParams
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  const [grants, lookups] = await Promise.all([listGrants(ctx), readLookups(ctx)])
  const byUser = new Map(grants.map((grant) => [grant.userId, grant]))

  // Everyone in the workspace, not only those with a grant: the interesting row is
  // the person who has not connected one.
  const people =
    session.role === 'admin'
      ? lookups.users
      : lookups.users.filter((member) => member.id === session.userId)

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <header className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-medium">Calendars</h1>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
          <Link href={bookingPagesPath(workspace)} className="text-link">
            Meeting links
          </Link>
          <Link href={availabilityPath(workspace)} className="text-link">
            My hours
          </Link>
        </div>
      </header>

      {error ? (
        <p role="alert" className="mb-4 rounded-panel border border-error bg-error-subtle p-3 text-sm">
          {error}
        </p>
      ) : null}

      {!googleCalendarConfigured ? (
        <p className="mb-4 rounded-panel border border-line bg-warning-subtle p-3 text-sm">
          Google Calendar is not configured on this deployment. It needs a Google Cloud project with
          an internal consent screen (open item 3) and an encryption key held outside the database
          (open item 9). Until then, free-busy cannot be read and no host can offer real times.
          {devCalendarEnabled
            ? ' The development provider below is available in the meantime: it treats a host as available except where Rawr already holds a booking, which exercises the whole engine without touching anybody’s real calendar.'
            : ''}
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {people.map((person) => (
          <CalendarRow
            key={person.id}
            userId={person.id}
            name={person.label}
            grant={byUser.get(person.id) ?? null}
            isSelf={person.id === session.userId}
            canConnectGoogle={googleCalendarConfigured}
            canConnectDev={devCalendarEnabled}
            editable={session.role !== 'viewer'}
            availabilityHref={availabilityPath(
              workspace,
              person.id === session.userId ? {} : { user: person.id },
            )}
          />
        ))}
      </ul>
    </div>
  )
}

export default CalendarsScreen
