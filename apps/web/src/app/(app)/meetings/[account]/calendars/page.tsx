import { Alert, PageHeader } from '@rawr/ui'
import { MeetingsTabs } from '../tabs.tsx'
import { listGrants } from '@rawr/db'
import { redirect } from 'next/navigation'
import { devCalendarEnabled, googleCalendarConfigured } from '~/lib/env.ts'
import { availabilityPath } from '~/lib/links.ts'
import { readLookups } from '~/server/crm.ts'
import { contextFrom, readSession, sessionIsAdmin, sessionIsReadOnly } from '~/server/session.ts'
import { CalendarRow } from './calendar-row.tsx'

/** Who has a working calendar connection, and what is wrong with the ones that
 *  do not. Reached from Settings; the rail's Calendar is the month.
 *
 *  This screen exists because a host without a calendar is silently unavailable
 *  everywhere: no error, just an empty booking page. The health state has to be
 *  visible somewhere, with the real reason on it. F2 §Edge cases.
 *
 *  Connecting happens at sign-in now, so this is the repair screen rather than the
 *  setup one: somebody who declined the calendar half of the consent, or revoked it
 *  afterwards, is fixed from here. */

const CalendarsScreen = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ error?: string }>
}) => {
  const { account } = await params
  const { error } = await searchParams
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  const [grants, lookups] = await Promise.all([listGrants(ctx), readLookups(ctx)])
  const byUser = new Map(grants.map((grant) => [grant.userId, grant]))

  // Everyone in the account, not only those with a grant: the interesting row is
  // the person who has not connected one.
  const people =
    sessionIsAdmin(session)
      ? lookups.users
      : lookups.users.filter((member) => member.id === session.userId)

  return (
    <div className="w-full max-w-4xl">
      <PageHeader
        className="mb-4"
        title="Calendar connections"
        lead="Whose free-busy Rawr may read when it offers somebody a time. Signing in with Google connects it, so this is where you come when that did not happen."
      />

      <MeetingsTabs account={account} current="calendars" />

      {error ? <Alert className="mb-4">{error}</Alert> : null}

      {!googleCalendarConfigured ? (
        <Alert tone="warning" className="mb-4">
          Google Calendar is not configured on this deployment. It needs a Google Cloud project with
          an internal consent screen (open item 3) and an encryption key held outside the database
          (open item 9). Until then, free-busy cannot be read and no host can offer real times.
          {devCalendarEnabled
            ? ' The development provider below is available in the meantime: it treats a host as available except where Rawr already holds a booking, which exercises the whole engine without touching anybody’s real calendar.'
            : ''}
        </Alert>
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
            editable={!sessionIsReadOnly(session)}
            availabilityHref={availabilityPath(
              account,
              person.id === session.userId ? {} : { user: person.id },
            )}
          />
        ))}
      </ul>
    </div>
  )
}

export default CalendarsScreen
