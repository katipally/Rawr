import { Alert, PageHeader } from '@rawr/ui'
import { MeetingsTabs } from '../tabs.tsx'
import { listGrants, pagesHostedBy, readSchedule } from '@rawr/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { availabilityPath, calendarsPath } from '~/lib/links.ts'
import { readLookups } from '~/server/crm.ts'
import { contextFrom, readSession, sessionIsAdmin, sessionIsReadOnly } from '~/server/session.ts'
import { ScheduleEditor } from './schedule-editor.tsx'

/** Working hours, per person rather than per page: a page inherits its hosts'
 *  hours, so somebody hosting three pages sets them once.
 *
 *  The subject is a query parameter, not a path segment, so a link with nobody
 *  named still opens on the right person: the one reading it. An admin can look at
 *  somebody else's by naming them. */

const AvailabilityScreen = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ user?: string }>
}) => {
  const { account } = await params
  const { user } = await searchParams
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  // Somebody else's hours are an admin's business only. A sales rep following a
  // pasted link to a colleague's schedule is bounced to their own rather than
  // shown a screen the save would refuse.
  const subject = user && sessionIsAdmin(session) ? user : session.userId
  const editable = !sessionIsReadOnly(session)

  const [schedule, lookups, pages, grants] = await Promise.all([
    readSchedule(ctx, subject),
    readLookups(ctx),
    pagesHostedBy(ctx, subject),
    listGrants(ctx),
  ])

  const person = lookups.users.find((member) => member.id === subject)
  const grant = grants.find((row) => row.userId === subject)

  return (
    <div className="w-full max-w-4xl">
      <PageHeader
        className="mb-4"
        title={subject === session.userId ? 'My working hours' : `${person?.label ?? 'Working hours'}`}
        lead="The window a meeting may be offered in, before the calendar narrows it further."
      />

      <MeetingsTabs account={account} current="availability" />

      {!grant || grant.state !== 'connected' ? (
        <Alert tone="warning" className="mb-4">
          {subject === session.userId ? 'You have' : `${person?.label ?? 'This person'} has`} no
          connected calendar, so no times are offered on any page{' '}
          {subject === session.userId ? 'you host' : 'they host'}. A host without a calendar is
          treated as unavailable rather than free, because guessing would double book a real person.{' '}
          <Link href={calendarsPath(account)}>Connect one</Link>.
        </Alert>
      ) : null}

      {sessionIsAdmin(session) && lookups.users.length > 1 ? (
        <nav className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-secondary">Looking at</span>
          {lookups.users.map((member) => (
            <Link
              key={member.id}
              href={availabilityPath(account, member.id === session.userId ? {} : { user: member.id })}
              aria-current={member.id === subject ? 'page' : undefined}
              className={
                member.id === subject
                  ? 'rounded-hs bg-accent-subtle px-2 py-0.5 font-semibold text-link no-underline'
                  : 'rounded-hs px-2 py-0.5 no-underline hover:bg-fill-hover'
              }
            >
              {member.label}
            </Link>
          ))}
        </nav>
      ) : null}

      <ScheduleEditor
        schedule={schedule}
        editable={editable}
        isSelf={subject === session.userId}
        hostedPages={pages.map((page) => ({ id: page.id, name: page.name, isActive: page.isActive }))}
        account={account}
      />
    </div>
  )
}

export default AvailabilityScreen
