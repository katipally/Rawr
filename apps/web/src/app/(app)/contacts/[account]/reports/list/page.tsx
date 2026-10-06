import { listReportDashboards } from '@rawr/db'
import { redirect } from 'next/navigation'
import { cardCatalogue } from '~/server/dashboard-cards.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { ReportsHeader } from '../header.tsx'
import { reportRange } from '../range.ts'
import { ReportList } from './report-list.tsx'

/** HubSpot's reports list: every report a dashboard can carry, how many of the
 *  dashboards this person can see carry it, and a link into the tab it comes
 *  from. O(dashboards x cards) to count, both small. */
const ReportsListScreen = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account } = await params
  const range = reportRange(session, await searchParams)
  const dashboards = await listReportDashboards(contextFrom(session))
  const used = new Map<string, number>()
  for (const dashboard of dashboards) for (const key of dashboard.cards) used.set(key, (used.get(key) ?? 0) + 1)

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReportsHeader account={account} current="dashboards" from={range.fromDay} to={range.toDay} />
      <ReportList
        account={account}
        from={range.fromDay}
        to={range.toDay}
        dashboards={dashboards.length}
        rows={cardCatalogue().map((card) => ({
          key: card.key,
          name: card.label,
          group: card.group,
          report: card.report,
          dashboards: used.get(card.key) ?? 0,
        }))}
      />
    </div>
  )
}

export default ReportsListScreen
