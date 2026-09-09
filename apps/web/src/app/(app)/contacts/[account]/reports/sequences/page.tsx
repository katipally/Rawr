import { sequencesReport } from '@rawr/db'
import { Card } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { BarChart } from '~/components/reports/chart.tsx'
import { contextFrom, readSession } from '~/server/session.ts'
import { ReportsHeader } from '../header.tsx'
import { reportRange } from '../range.ts'

const SequencesReport = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')
  const { account } = await params

  const range = await reportRange(session, await searchParams)
  const report = await sequencesReport(contextFrom(session), range)

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReportsHeader account={account} current="sequences" from={range.fromDay} to={range.toDay} />

      <div className="flex flex-col gap-4">
        <Card>
          <BarChart
            title="Per sequence"
            labels={report.sequences.map((row) => row.sequence)}
            series={[
              { label: 'Sent', values: report.sequences.map((row) => row.sent), tone: 'accent' },
              { label: 'Opened', values: report.sequences.map((row) => row.opened), tone: 'muted' },
              { label: 'Clicked', values: report.sequences.map((row) => row.clicked), tone: 'success' },
              { label: 'Replied', values: report.sequences.map((row) => row.replied), tone: 'warning' },
              { label: 'Bounced', values: report.sequences.map((row) => row.bounced), tone: 'error' },
            ]}
          />
          <p className="mt-2 max-w-prose text-small text-secondary">
            Opens count mails that were opened at least once, not pixel loads: a mail read four times
            is one person reading it. Apple's privacy proxy opens some mail on the recipient's behalf,
            so treat opens as a floor on interest rather than a measurement of it.
          </p>
        </Card>

        <Card title="Per mailbox">
          {report.mailboxes.length === 0 ? (
            <p className="text-secondary">No sequence mail was sent in this range.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-small">
                <thead>
                  <tr className="border-b border-divider text-left text-secondary">
                    <th scope="col" className="py-1 pr-3 font-medium">Mailbox</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Sent</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Bounced</th>
                    <th scope="col" className="py-1 text-right font-medium">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {report.mailboxes.map((row) => (
                    <tr key={row.mailbox} className="border-b border-divider last:border-0">
                      <th scope="row" className="py-1 pr-3 text-left font-normal">{row.mailbox}</th>
                      <td className="py-1 pr-3 text-right tabular-nums">{row.sent}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{row.bounced}</td>
                      <td className="py-1 text-right tabular-nums">{row.failed}</td>
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

export default SequencesReport
