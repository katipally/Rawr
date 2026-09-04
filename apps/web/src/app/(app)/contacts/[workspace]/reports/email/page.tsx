import { emailReport } from '@rawr/db'
import { Card } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { BarChart } from '~/components/reports/chart.tsx'
import { contextFrom, readSession } from '~/server/session.ts'
import { ReportsHeader } from '../header.tsx'
import { rangeFrom } from '../range.ts'

const hours = (value: number | null): string => {
  if (value === null) return '—'
  if (value < 1) return `${Math.round(value * 60)} min`
  if (value < 48) return `${value.toFixed(1)} h`
  return `${(value / 24).toFixed(1)} days`
}

const EmailReport = async ({
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
  const report = await emailReport(contextFrom(session), range)
  const lagOf = (mailbox: string) => report.replyLag.find((row) => row.mailbox === mailbox)

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReportsHeader workspace={workspace} current="email" from={range.fromDay} to={range.toDay} />

      <div className="flex flex-col gap-4">
        <Card>
          <BarChart
            title="Mail through connected inboxes"
            labels={report.mailboxes.map((row) => row.mailbox)}
            series={[
              { label: 'Sent', values: report.mailboxes.map((row) => row.sent), tone: 'accent' },
              { label: 'Received', values: report.mailboxes.map((row) => row.received), tone: 'success' },
            ]}
          />
        </Card>

        <Card title="How long people wait for an answer">
          {report.mailboxes.length === 0 ? (
            <p className="text-secondary">No mail passed through a connected mailbox in this range.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-small">
                  <thead>
                    <tr className="border-b border-divider text-left text-secondary">
                      <th scope="col" className="py-1 pr-3 font-medium">Mailbox</th>
                      <th scope="col" className="py-1 pr-3 text-right font-medium">Threads</th>
                      <th scope="col" className="py-1 pr-3 text-right font-medium">Replies</th>
                      <th scope="col" className="py-1 text-right font-medium">Typical wait</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.mailboxes.map((row) => {
                      const lag = lagOf(row.mailbox)
                      return (
                        <tr key={row.mailbox} className="border-b border-divider last:border-0">
                          <th scope="row" className="py-1 pr-3 text-left font-normal">{row.mailbox}</th>
                          <td className="py-1 pr-3 text-right tabular-nums">{row.threads}</td>
                          <td className="py-1 pr-3 text-right tabular-nums">{lag?.replies ?? 0}</td>
                          <td className="py-1 text-right tabular-nums">{hours(lag?.medianHours ?? null)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 max-w-prose text-small text-secondary">
                The typical wait is the median, not the average: one thread answered after a fortnight
                should not make a team that replies within the hour look like it replies within a day.
                Only mail that got an answer is counted, so this says how long answers take, not how
                often they come.
              </p>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}

export default EmailReport
