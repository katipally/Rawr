import { websiteReport } from '@rawr/db'
import { Card } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { BarChart } from '~/components/reports/chart.tsx'
import { contextFrom, readSession } from '~/server/session.ts'
import { ReportsHeader } from '../header.tsx'
import { rangeFrom } from '../range.ts'

const WebsiteReport = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')
  const { account } = await params

  const range = rangeFrom(await searchParams)
  const report = await websiteReport(contextFrom(session), range)
  const { sessions, identified } = report.identifiedShare

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReportsHeader account={account} current="website" from={range.fromDay} to={range.toDay} />

      <div className="flex flex-col gap-4">
        <Card>
          <BarChart
            title="Visits by channel"
            labels={report.channels.map((row) => row.channel)}
            series={[
              { label: 'Visits', values: report.channels.map((row) => row.sessions), tone: 'accent' },
              { label: 'By somebody we can name', values: report.channels.map((row) => row.identified), tone: 'success' },
            ]}
          />
          <p className="mt-2 max-w-prose text-small text-secondary">
            {sessions === 0
              ? 'No visits were recorded in this range.'
              : `${identified} of ${sessions} visits were by somebody Rawr can put a name to. Anonymous visits are a page-view counter; named ones are a CRM.`}
            {' '}
            A visit is labelled once, on its first page: a later page carries the internal referrer of
            the one before it, which would relabel a paid click halfway through.
          </p>
        </Card>

        <div className="grid gap-4 @4xl:grid-cols-2">
          <Card title="Campaigns">
            {report.campaigns.length === 0 ? (
              <p className="text-secondary">No visit in this range carried a campaign tag.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-small">
                  <thead>
                    <tr className="border-b border-divider text-left text-secondary">
                      <th scope="col" className="py-1 pr-3 font-medium">Source</th>
                      <th scope="col" className="py-1 pr-3 font-medium">Medium</th>
                      <th scope="col" className="py-1 pr-3 font-medium">Campaign</th>
                      <th scope="col" className="py-1 text-right font-medium">Visits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.campaigns.map((row) => (
                      <tr key={`${row.source}/${row.medium}/${row.campaign}`} className="border-b border-divider last:border-0">
                        <td className="py-1 pr-3">{row.source}</td>
                        <td className="py-1 pr-3">{row.medium}</td>
                        <td className="py-1 pr-3">{row.campaign}</td>
                        <td className="py-1 text-right tabular-nums">{row.sessions}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Most read pages">
            {report.pages.length === 0 ? (
              <p className="text-secondary">No page was viewed in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-small">
                  <thead>
                    <tr className="border-b border-divider text-left text-secondary">
                      <th scope="col" className="py-1 pr-3 font-medium">Path</th>
                      <th scope="col" className="py-1 pr-3 text-right font-medium">Views</th>
                      <th scope="col" className="py-1 text-right font-medium">People</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.pages.map((row) => (
                      <tr key={row.path} className="border-b border-divider last:border-0">
                        <th scope="row" className="py-1 pr-3 text-left font-normal">{row.path}</th>
                        <td className="py-1 pr-3 text-right tabular-nums">{row.views}</td>
                        <td className="py-1 text-right tabular-nums">{row.visitors}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

export default WebsiteReport
