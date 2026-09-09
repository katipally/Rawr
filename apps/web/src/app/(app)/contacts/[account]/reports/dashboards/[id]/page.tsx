import { listReportDashboards, readReportDashboard } from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import { LinkButton } from '~/components/link-button.tsx'
import { redirect } from 'next/navigation'
import { reportsPath } from '~/lib/links.ts'
import { cardCatalogue, renderCards } from '~/server/dashboard-cards.ts'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
import { ReportsHeader } from '../../header.tsx'
import { reportRange } from '../../range.ts'
import { DashboardView } from './dashboard-view.tsx'

/** B11. One dashboard, drawn over the range in the URL.
 *
 *  The cards are rendered on the server for the same reason the reports are: the
 *  figures come from grouped scans that belong next to the database, and a screen
 *  of eight cards should be one request rather than eight. */

const DashboardScreen = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; id: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account, id } = await params
  const range = await reportRange(session, await searchParams)
  const ctx = contextFrom(session)
  const [found, all] = await Promise.all([readReportDashboard(ctx, id), listReportDashboards(ctx)])

  if (!found) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <ReportsHeader account={account} current="dashboards" from={range.fromDay} to={range.toDay} />
        <EmptyState
          title="That dashboard is not here"
          description="It may have been deleted, or it may be somebody's private one."
          action={
            <LinkButton variant="primary" href={reportsPath(account, { tab: 'dashboards', from: range.fromDay, to: range.toDay })}>
              Back to dashboards
            </LinkButton>
          }
        />
      </div>
    )
  }

  const cards = await renderCards(ctx, found.cards, range)
  // Every key that is no longer in the catalogue. Said out loud rather than
  // silently dropped, because a card that quietly stopped appearing looks like a
  // number that went to zero.
  const retired = found.cards.length - cards.length

  return (
    <div className="flex min-w-0 flex-col">
      <DashboardView
        account={account}
        from={range.fromDay}
        to={range.toDay}
        catalogue={cardCatalogue()}
        retired={retired}
        dashboard={{
          id: found.id,
          name: found.name,
          isShared: found.isShared,
          cards: found.cards,
          ownerName: found.ownerName,
        }}
        rendered={cards}
        all={all.map((row) => ({ id: row.id, name: row.name }))}
        canEdit={found.ownerId === null || found.ownerId === session.userId || sessionIsAdmin(session)}
      />
    </div>
  )
}

export default DashboardScreen
