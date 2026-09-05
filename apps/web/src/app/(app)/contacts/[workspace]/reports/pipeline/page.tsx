import { pipelineReport } from '@rawr/db'
import { Card } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { BarChart, Funnel } from '~/components/reports/chart.tsx'
import { formatCurrency, formatDayShort } from '~/components/crm/value.tsx'
import { contextFrom, readSession } from '~/server/session.ts'
import { ReportsHeader } from '../header.tsx'
import { rangeFrom } from '../range.ts'

/** Amounts are summed without converting between currencies: converting at
 *  today's rate would make last quarter's number move every morning. */
const money = (value: number) => formatCurrency(value)

const PipelineReport = async ({
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
  const report = await pipelineReport(contextFrom(session), range)

  // One funnel per pipeline. The rows arrive in pipeline then stage order, so
  // grouping is a single pass and the stages inside each group keep their order.
  const pipelines: { id: string; name: string; steps: typeof report.funnel }[] = []
  for (const row of report.funnel) {
    const last = pipelines.at(-1)
    if (last?.id === row.pipelineId) last.steps.push(row)
    else pipelines.push({ id: row.pipelineId, name: row.pipeline, steps: [row] })
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReportsHeader workspace={workspace} current="pipeline" from={range.fromDay} to={range.toDay} />

      <div className="grid gap-4 @4xl:grid-cols-2">
        <Card className="@4xl:col-span-2">
          <BarChart
            title="Deals each week"
            labels={report.weeks.map((row) => formatDayShort(row.week))}
            series={[
              { label: 'Created', values: report.weeks.map((row) => row.created), tone: 'accent' },
              { label: 'Won', values: report.weeks.map((row) => row.won), tone: 'success' },
              { label: 'Lost', values: report.weeks.map((row) => row.lost), tone: 'error' },
            ]}
          />
        </Card>

        {pipelines.map((group) => (
          <Card key={group.id}>
            <Funnel
              title={`${group.name}: where the deals created in this range are now`}
              steps={group.steps.map((row) => ({
                id: row.stageId,
                label: row.stage,
                value: row.deals,
                detail: row.amount > 0 ? money(row.amount) : undefined,
              }))}
            />
          </Card>
        ))}

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
                      <td className="py-1 text-right tabular-nums">{money(row.wonAmount)}</td>
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
