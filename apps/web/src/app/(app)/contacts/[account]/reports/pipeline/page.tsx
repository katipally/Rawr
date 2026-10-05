import { pipelineReport } from '@rawr/db'
import { Card } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { BarChart, Funnel } from '~/components/reports/chart.tsx'
import { reportsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { ReportsHeader } from '../header.tsx'
import { reportRange } from '../range.ts'
import { getFormat } from '~/server/format.ts'

const PipelineReport = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ from?: string; to?: string; pipelines?: string }>
}) => {
  const fmt = await getFormat()
  const session = await readSession()
  if (!session) redirect('/sign-in')
  const { account } = await params

  const search = await searchParams
  const range = reportRange(session, search)
  const report = await pipelineReport(contextFrom(session), range)

  // One funnel per pipeline. The rows arrive in pipeline then stage order, so
  // grouping is a single pass and the stages inside each group keep their order.
  const pipelines: { id: string; name: string; steps: typeof report.funnel }[] = []
  for (const row of report.funnel) {
    const last = pipelines.at(-1)
    if (last?.id === row.pipelineId) last.steps.push(row)
    else pipelines.push({ id: row.pipelineId, name: row.pipeline, steps: [row] })
  }
  // A pipeline nobody has used, such as the default one beside the real one, is a
  // chart of zeros. Hidden unless asked for, and kept when every one is empty so
  // the page is never blank.
  const used = pipelines.filter((group) => group.steps.some((row) => row.deals > 0))
  const showAll = search.pipelines === 'all' || used.length === 0
  const shown = showAll ? pipelines : used
  const hidden = pipelines.length - shown.length

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReportsHeader account={account} current="pipeline" from={range.fromDay} to={range.toDay} />

      <div className="grid gap-4 @4xl:grid-cols-2">
        <Card className="@4xl:col-span-2">
          <BarChart
            format={fmt.number}
            title="Deals made and closed each week"
            labels={report.weeks.map((row) => fmt.dayShort(row.week))}
            series={[
              { label: 'Created', values: report.weeks.map((row) => row.created), tone: 'accent' },
              { label: 'Won', values: report.weeks.map((row) => row.won), tone: 'success' },
              { label: 'Lost', values: report.weeks.map((row) => row.lost), tone: 'error' },
            ]}
          />
        </Card>

        {shown.map((group) => (
          <Card key={group.id}>
            <Funnel
              format={fmt.number}
              title={`${group.name}: where the deals created in this range are now`}
              steps={group.steps.map((row) => ({
                id: row.stageId,
                label: row.stage,
                value: row.deals,
                detail: row.amounts.length > 0 ? fmt.amounts(row.amounts) : undefined,
              }))}
            />
          </Card>
        ))}

        {hidden > 0 ? (
          <p className="text-small text-secondary @4xl:col-span-2">
            {hidden} {hidden === 1 ? 'pipeline' : 'pipelines'} with no deals in this range{' '}
            {hidden === 1 ? 'is' : 'are'} hidden.{' '}
            <Link href={reportsPath(account, { tab: 'pipeline', from: range.fromDay, to: range.toDay, pipelines: 'all' })}>
              Show {hidden === 1 ? 'it' : 'them'}
            </Link>
          </p>
        ) : null}

        <Card title="By owner">
          {report.owners.length === 0 ? (
            <p className="text-secondary">No deals were created in this range.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-small">
                <thead>
                  <tr className="border-b border-divider text-left text-secondary">
                    <th scope="col" className="py-1 pr-3 font-medium">Owner</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Open</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Won</th>
                    <th scope="col" className="py-1 text-right font-medium">Won amount</th>
                  </tr>
                </thead>
                <tbody>
                  {report.owners.map((row) => (
                    <tr key={row.owner} className="border-b border-divider last:border-0">
                      <th scope="row" className="py-1 pr-3 text-left font-normal">{row.owner}</th>
                      <td className="py-1 pr-3 text-right tabular-nums">{row.open}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{row.won}</td>
                      <td className="py-1 text-right tabular-nums">{fmt.amounts(row.wonAmounts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

export default PipelineReport
