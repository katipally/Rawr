import { attributionReport } from '@rawr/db'
import { Card } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { BarChart } from '~/components/reports/chart.tsx'
import { formatCurrency } from '~/components/crm/value.tsx'
import { contextFrom, readSession } from '~/server/session.ts'
import { ReportsHeader } from '../header.tsx'
import { rangeFrom } from '../range.ts'

/** Both touches, side by side and never blended. First touch credits what found
 *  somebody, last touch credits what closed them, and one number that mixes the
 *  two hides which of the two a channel is actually good at. */
const Touch = ({
  title,
  explanation,
  rows,
}: {
  title: string
  explanation: string
  rows: { channel: string; contacts: number; deals: number; wonAmount: number }[]
}) => (
      <Card>
    <BarChart
      title={title}
      labels={rows.map((row) => row.channel)}
      series={[
        { label: 'Contacts', values: rows.map((row) => row.contacts), tone: 'accent' },
        { label: 'Deals', values: rows.map((row) => row.deals), tone: 'success' },
      ]}
    />
    <p className="mt-2 max-w-prose text-small text-secondary">{explanation}</p>
    {rows.length > 0 ? (
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-small">
          <thead>
            <tr className="border-b border-divider text-left text-secondary">
              <th scope="col" className="py-1 pr-3 font-medium">Channel</th>
              <th scope="col" className="py-1 text-right font-medium">Won amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.channel} className="border-b border-divider last:border-0">
                <th scope="row" className="py-1 pr-3 text-left font-normal">{row.channel}</th>
                <td className="py-1 text-right tabular-nums">{formatCurrency(row.wonAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : null}
  </Card>
)

const AttributionReport = async ({
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
  const report = await attributionReport(contextFrom(session), range)
  const unattributed = report.first.find((row) => row.channel === 'Not attributed')

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReportsHeader workspace={workspace} current="attribution" from={range.fromDay} to={range.toDay} />

  <div className="flex flex-col gap-4">
        {unattributed && unattributed.contacts > 0 ? (
          <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
            {unattributed.contacts} contact{unattributed.contacts === 1 ? '' : 's'} created in this
            range carry no source. Most will be imports and records typed in by hand, which never had
            a first touch. They are shown as "Not attributed" rather than dropped: a report that
            quietly leaves out half the contacts is worse than one that admits to it.
          </p>
        ) : null}

        <div className="grid gap-4 @4xl:grid-cols-2">
          <Touch
            title="First touch"
            explanation="Where these contacts came from the very first time Rawr saw them. Once a visitor is identified, their earliest visit is used even if it predates the form that named them, so an ad that found somebody in March is not credited to the July form fill."
            rows={report.first}
          />
          <Touch
            title="Last touch"
            explanation="The most recent thing that brought them back. Updated on every new visit and every form fill, so this moves while first touch does not."
            rows={report.last}
          />
        </div>
      </div>
    </div>
  )
}

export default AttributionReport
