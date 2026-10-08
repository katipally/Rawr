import { formsReport } from '@rawr/db'
import { Card } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { BarChart } from '~/components/reports/chart.tsx'
import { contextFrom, readSession } from '~/server/session.ts'
import { ReportsHeader } from '../header.tsx'
import { reportRange } from '../range.ts'
import { getFormat } from '~/server/format.ts'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'

const FormsReport = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}) => {
  const fmt = await getFormat()
  const session = await readSession()
  if (!session) redirect('/sign-in')
  const { account } = await params

  const range = reportRange(session, await searchParams)
  const report = await formsReport(contextFrom(session), range)

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReportsHeader account={account} current="forms" from={range.fromDay} to={range.toDay} clipped={range.clipped} />

      <div className="flex flex-col gap-4">
        <Card>
          <BarChart
            format={fmt.number}
            title="Fills each day"
            labels={report.days.map((row) => fmt.dayShort(row.day))}
            series={[
              { label: 'Kept', values: report.days.map((row) => row.clean), tone: 'accent' },
              { label: 'Held for review', values: report.days.map((row) => row.held), tone: 'warning' },
            ]}
          />
          <p className="mt-2 max-w-prose text-small text-secondary">
            Held fills are counted rather than hidden. A form whose numbers dropped because the spam
            filter tightened looks exactly like one nobody is filling in, unless both lines are here.
          </p>
        </Card>

        <Card title="What each form produced">
          {report.forms.length === 0 ? (
            <p className="text-secondary">No form was filled in during this range.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-small">
                <thead>
                  <tr className="border-b border-divider text-left text-secondary">
                    <th scope="col" className="py-1 pr-3 font-medium">Form</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Seen</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Fills</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Filled in</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Pages</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Held</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Contacts</th>
                    <th scope="col" className="py-1 text-right font-medium">Deals after</th>
                  </tr>
                </thead>
                <tbody>
                  {report.forms.map((row) => (
                    <tr key={row.id} className="border-b border-divider last:border-0">
                      <th scope="row" className="py-1 pr-3 text-left font-normal">{row.form}</th>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {row.views === 0 ? EMPTY_VALUE : fmt.number(row.views)}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums">{row.submissions}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {row.views === 0 ? EMPTY_VALUE : fmt.percent(row.submissions / row.views, 1)}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {row.appearsOn === 0 ? EMPTY_VALUE : row.appearsOn}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums">{row.held}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{row.contacts}</td>
                      <td className="py-1 text-right tabular-nums">{row.deals}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 max-w-prose text-small text-secondary">
            &ldquo;Seen&rdquo; counts the embed painting the form, through the same consent gate
            every other event goes through, so a visitor who declined analytics is not in it and the
            rate reads low rather than wrong. A dash means the form was only ever opened on its
            hosted page, where nothing counts a view.
          </p>
          <p className="mt-2 max-w-prose text-small text-secondary">
            "Deals after" counts deals opened at the form's company after the fill. It is a
            coincidence in time, not a claim that the form caused the deal; the attribution report is
            where that question is answered.
          </p>
        </Card>
      </div>
    </div>
  )
}

export default FormsReport
