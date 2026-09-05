import { listBookingPages } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { publicBaseUrl } from '~/lib/env.ts'
import { bookedPath, bookingPagesPath, calendarsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { BookingLinkSnippet } from './snippet.tsx'
import { NewPageButton } from './new-page.tsx'

/** Every booking page in the workspace, plus this person's own calendar links.
 *  Somebody else's personal link is not listed, because it is theirs. F2 §6. */

const LOCATIONS: Record<string, string> = {
  zoom: 'Zoom',
  google_meet: 'Google Meet',
  phone: 'Phone',
  custom: 'Custom',
}

const BookingPagesScreen = async ({ params }: { params: Promise<{ workspace: string }> }) => {
  const { workspace } = await params
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const pages = await listBookingPages(contextFrom(session))
  const shared = pages.filter((page) => page.kind === 'round_robin')
  const mine = pages.filter((page) => page.kind === 'one_on_one')
  const unhealthy = pages.reduce((total, page) => total + page.unhealthyHosts, 0)

  return (
    <div className="w-full max-w-6xl">
      <PageHeader
        className="mb-4"
        title="Meeting links"
        lead={
          <>
            {shared.length === 1 ? '1 shared page' : `${shared.length} shared pages`} ·{' '}
            {mine.length === 1 ? '1 personal link' : `${mine.length} personal links`}
            {unhealthy > 0 ? (
              <>
                {' · '}
                <Link href={calendarsPath(workspace)} className="font-semibold text-link">
                  {unhealthy === 1
                    ? '1 host has no working calendar'
                    : `${unhealthy} hosts have no working calendar`}
                </Link>
              </>
            ) : null}
          </>
        }
        why="A shared round robin spreads inbound meetings across a team; a personal link is one person's own, for an email signature. A host with no working calendar is treated as unavailable rather than free, which is why the count above is worth chasing."
        action={
          <>
            <Link href={bookedPath(workspace)} className="text-sm font-semibold text-link">
              Booked meetings
            </Link>
            {session.role === 'viewer' ? null : (
              <NewPageButton workspace={workspace} canCreateShared={session.role === 'admin'} />
            )}
          </>
        }
      />

      {pages.length === 0 ? (
        <EmptyState
          title="No meeting links yet"
          description="Make one and put its link in an email signature."
        />
      ) : null}

      {[
        { label: 'Shared round robin', rows: shared },
        { label: 'My personal links', rows: mine },
      ]
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <section key={group.label} className="mb-6">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-secondary">
              {group.label}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {group.rows.map((page) => (
                <li
                  key={page.id}
                  className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Link
                      href={bookingPagesPath(workspace, page.id)}
                      className="font-semibold text-link"
                    >
                      {page.name}
                    </Link>
                    {!page.isActive ? (
                      <span className="rounded-hs bg-disabled px-1.5 py-0.5 text-xs text-secondary">
                        Off
                      </span>
                    ) : null}
                    {page.unhealthyHosts > 0 ? (
                      <span className="rounded-hs bg-error-subtle px-1.5 py-0.5 text-xs text-error">
                        {page.unhealthyHosts} without a calendar
                      </span>
                    ) : null}
                  </div>

                  <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary">
                    <div>
                      <dt className="inline">Length </dt>
                      <dd className="inline font-medium text-body">{page.durationMinutes} min</dd>
                    </div>
                    <div>
                      <dt className="inline">Where </dt>
                      <dd className="inline font-medium text-body">
                        {LOCATIONS[page.location] ?? page.location}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">Hosts </dt>
                      <dd className="inline font-medium text-body">{page.hostCount}</dd>
                    </div>
                    <div>
                      <dt className="inline">Upcoming </dt>
                      <dd className="inline font-medium text-body">
                        <Link href={bookedPath(workspace, { page: page.id })} className="text-link">
                          {page.upcoming}
                        </Link>
                      </dd>
                    </div>
                  </dl>

                  <BookingLinkSnippet
                    baseUrl={publicBaseUrl}
                    workspace={session.workspaceSlug}
                    slug={page.slug}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  )
}

export default BookingPagesScreen
