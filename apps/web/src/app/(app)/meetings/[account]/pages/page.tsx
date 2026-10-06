import { listBookingPages, listGrants } from '@rawr/db'
import { Alert, EmptyState, PageHeader } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { LinkButton } from '~/components/link-button.tsx'
import { googleCalendarConfigured, publicBaseUrl } from '~/lib/env.ts'
import { calendarsPath } from '~/lib/links.ts'
import { contextFrom, readSession, sessionIsAdmin, sessionIsReadOnly } from '~/server/session.ts'
import { zoomReady } from '~/server/zoom.ts'
import { PagesTable } from './pages-table.tsx'
import { NewPageButton } from './new-page.tsx'
import { MeetingsTabs } from '../tabs.tsx'

/** Every booking page in the account, plus this person's own calendar links.
 *  Somebody else's personal link is not listed, because it is theirs. F2 §6. */
const BookingPagesScreen = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ new?: string; q?: string; owner?: string; type?: string }>
}) => {
  const { account } = await params
  const { new: creating, q, owner, type } = await searchParams
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  const [pages, zoom, grants] = await Promise.all([listBookingPages(ctx), zoomReady(ctx), listGrants(ctx)])
  const shared = pages.filter((page) => page.kind !== 'one_on_one')
  const mine = pages.filter((page) => page.kind === 'one_on_one')
  const unhealthy = pages.reduce((total, page) => total + page.unhealthyHosts, 0)
  const connected = grants.some((grant) => grant.userId === session.userId && grant.state === 'connected')

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
                <Link href={calendarsPath(account)} className="font-semibold text-link">
                  {unhealthy === 1
                    ? '1 host has no working calendar'
                    : `${unhealthy} hosts have no working calendar`}
                </Link>
              </>
            ) : null}
          </>
        }
        why="A shared round robin spreads inbound meetings across a team; a personal link is one person's own, for an email signature. A host with no working calendar is treated as unavailable rather than free, which is why the count above is worth chasing. There is no delete: a page that has taken meetings is what those meetings point at, so turning it off is how it ends. It stops offering times and the link stops working, and every meeting already booked on it keeps its history."
        action={
          sessionIsReadOnly(session) ? null : (
            <NewPageButton
              account={account}
              canCreateShared={sessionIsAdmin(session)}
              defaultLocation={zoom ? 'zoom' : googleCalendarConfigured ? 'google_meet' : 'phone'}
              startOpen={creating === '1'}
            />
          )
        }
      />

      <MeetingsTabs account={account} current="pages" />

      {connected ? null : (
        <Alert tone="warning" action={<LinkButton href={calendarsPath(account)}>Connect calendar</LinkButton>}>
          <strong className="font-semibold">Your calendar is not connected.</strong> Connect it so the pages you host
          can offer times.
        </Alert>
      )}

      {pages.length === 0 ? (
        <EmptyState
          title="No meeting links yet"
          description="Make one and put its link in an email signature."
        />
      ) : (
        <PagesTable
          account={session.accountSlug}
          baseUrl={publicBaseUrl}
          rows={pages}
          viewer={{ id: session.userId, isAdmin: sessionIsAdmin(session) }}
          query={{ q: q ?? '', owner: owner ?? null, type: type ?? null }}
        />
      )}
    </div>
  )
}

export default BookingPagesScreen
