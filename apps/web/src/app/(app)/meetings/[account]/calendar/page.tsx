import { listMembers, readAgenda } from '@rawr/db'
import { PageHeader, Select } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { CalendarGrid } from '~/components/crm/calendar-grid.tsx'
import {
  bookedPath,
  bookingPagesPath,
  calendarPath,
  calendarsPath,
  recordPath,
  tasksPath,
} from '~/lib/links.ts'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'

/** The month, for one person.
 *
 *  The rail's Calendar used to open the list of Google accounts Rawr may read
 *  free-busy from, which is plumbing rather than a calendar. This is the screen
 *  the label promises: the meetings booked with you and the tasks due from you,
 *  on the days they fall.
 *
 *  Whose month, and which month, are both in the address, so a manager can send
 *  somebody a link to their own week. */

const MONTH = /^\d{4}-\d{2}$/

/** UTC, and the same as the object calendar's: the grid highlights a day by
 *  string comparison, so both screens have to agree on what today is called. */
const todayIso = (): string => new Date().toISOString().slice(0, 10)

const CalendarScreen = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ month?: string; who?: string }>
}) => {
  const { account } = await params
  const query = await searchParams
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  // The reader's own today decides the default month, not the server's.
  const month = MONTH.test(query.month ?? '') ? `${query.month}-01` : `${todayIso().slice(0, 7)}-01`
  // Everybody's is only an admin's to ask for: a rep's calendar is theirs.
  const everyone = query.who === 'all' && sessionIsAdmin(session)
  const who = everyone ? null : query.who && sessionIsAdmin(session) ? query.who : session.userId

  const [agenda, members] = await Promise.all([
    readAgenda(ctx, { month, userId: who }),
    sessionIsAdmin(session) ? listMembers(ctx) : Promise.resolve([]),
  ])

  const whose =
    everyone
      ? 'Everybody'
      : (members.find((member) => member.userId === who)?.name ?? 'You')

  return (
    <div className="flex w-full max-w-6xl flex-col gap-4">
      <PageHeader
        title="Calendar"
        lead={`${whose === 'You' ? 'Meetings booked with you and tasks due from you' : `${whose}’s meetings and tasks`}.`}
        why="Meetings come from the scheduling pages and tasks from whatever created them, so this is one month of everything already in Rawr rather than a second place to keep a diary. It is not a Google calendar: which accounts Rawr may read free-busy from is a separate screen."
        action={
          <span className="flex flex-wrap items-center gap-3">
            <Link href={bookedPath(account)} className="text-sm font-semibold text-link">
              Booked meetings
            </Link>
            <Link href={bookingPagesPath(account)} className="text-sm text-link">
              Meeting links
            </Link>
            <Link href={calendarsPath(account)} className="text-sm text-link">
              Calendar connections
            </Link>
          </span>
        }
      />

      {sessionIsAdmin(session) && members.length > 1 ? (
        <form method="get" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="month" value={month.slice(0, 7)} />
          <Select
            aria-label="Whose calendar"
            name="who"
            defaultValue={everyone ? 'all' : (who ?? '')}
            className="w-auto min-w-48"
          >
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.name}
              </option>
            ))}
            <option value="all">Everybody</option>
          </Select>
          {/* A plain form, so this works before the page has hydrated and the
              address still carries the choice. */}
          <button type="submit" className="h-control rounded-pill border border-line-strong px-4 text-small">
            Show
          </button>
        </form>
      ) : null}

      <CalendarGrid
        month={agenda.month}
        today={todayIso()}
        truncated={agenda.truncated}
        fieldLabel="The day they happen, or fall due"
        entries={agenda.entries.map((entry) => ({
          id: entry.id,
          displayName: entry.displayName,
          day: entry.day,
          time: entry.time,
          // A meeting opens the person it is with, because that is what somebody
          // clicking a meeting wants; with nobody attached, the booked list
          // filtered to nothing useful is worse than the list itself.
          href:
            entry.entityType && entry.entityId
              ? recordPath(account, entry.entityType, entry.entityId)
              : entry.kind === 'meeting'
                ? bookedPath(account)
                : tasksPath(account),
        }))}
        monthHref={(next) =>
          calendarPath(account, {
            month: next.slice(0, 7),
            ...(everyone ? { who: 'all' } : who && who !== session.userId ? { who } : {}),
          })
        }
      />
    </div>
  )
}

export default CalendarScreen
