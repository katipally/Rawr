import { listReportDashboards } from '@rawr/db'
import { Card } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { cardCatalogue } from '~/server/dashboard-cards.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { ReportsHeader } from '../header.tsx'
import { rangeFrom } from '../range.ts'
import { DashboardList } from './dashboard-list.tsx'

/** B11. The dashboards this person can see, and the button that makes another.
 *
 *  The range in the URL is carried into every link out of here, so opening a
 *  dashboard from the reports keeps the period the reports were being read over. */

const DashboardsScreen = async ({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { workspace } = await params
  const range = rangeFrom(await searchParams)
  const rows = await listReportDashboards(contextFrom(session))

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReportsHeader workspace={workspace} current="dashboards" from={range.fromDay} to={range.toDay} />

      <Card title="Dashboards">
        <DashboardList
          workspace={workspace}
          from={range.fromDay}
          to={range.toDay}
          catalogue={cardCatalogue()}
          rows={rows.map((row) => ({
            id: row.id,
            name: row.name,
            ownerName: row.ownerName,
            isShared: row.isShared,
            cards: row.cards,
            updatedAt: row.updatedAt.toISOString(),
            mine: row.ownerId === session.userId,
          }))}
        />
      </Card>
    </div>
  )
}

export default DashboardsScreen
