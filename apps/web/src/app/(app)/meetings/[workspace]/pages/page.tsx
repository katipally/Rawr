import { listBookingPages } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { publicBaseUrl } from '~/lib/env.ts'
import { bookedPath, bookingPagesPath, calendarsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { PagesTable } from './pages-table.tsx'
import { NewPageButton } from './new-page.tsx'

/** Every booking page in the workspace, plus this person's own calendar links.
 *  Somebody else's personal link is not listed, because it is theirs. F2 §6. */
const BookingPagesScreen = async ({ params }: { params: Promise<{ workspace: string }> }) => {
  const { workspace } = await params
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const pages = await listBookingPages(contextFrom(session))
  const shared = pages.filter((page) => page.kind === 'round_robin')
  const mine = pages.filter((page) => page.kind === 'one_on_one')
  const unhealthy = pages.reduce((total, page) => total + page.unhealthyHosts, 0)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Meetings"
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
          <span className="flex flex-wrap items-center gap-3">
            <Link href={bookedPath(workspace)} className="font-semibold text-link">
              Booked meetings
            </Link>
            {session.role === 'viewer' ? null : (
              <NewPageButton workspace={workspace} canCreateShared={session.role === 'admin'} />
            )}
          </span>
        }
      />

      {pages.length === 0 ? (
        <EmptyState
          title="No meeting links yet"
          description="Make one and put its link in an email signature."
        />
      ) : (
        <PagesTable workspace={session.workspaceSlug} baseUrl={publicBaseUrl} rows={pages} />
      )}
    </div>
  )
}

export default BookingPagesScreen
