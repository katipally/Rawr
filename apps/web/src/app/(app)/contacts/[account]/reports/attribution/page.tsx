import { attributionReport, campaignPerformance, type CampaignPerformance } from '@rawr/db'
import { Card } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { BarChart } from '~/components/reports/chart.tsx'
import { contextFrom, readSession } from '~/server/session.ts'
import { ReportsHeader } from '../header.tsx'
import { reportRange } from '../range.ts'
import { getFormat } from '~/server/format.ts'

/** Both touches, side by side and never blended. First touch credits what found
 *  somebody, last touch credits what closed them, and one number that mixes the
 *  two hides which of the two a channel is actually good at. */
const Touch = async ({
  title,
  explanation,
  rows,
}: {
  title: string
  explanation: string
  rows: { channel: string; contacts: number; deals: number; wonAmounts: { currency: string; amount: number }[] }[]
}) => {
  const fmt = await getFormat()
  return (
      <Card>
    <BarChart
      format={fmt.number}
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
                <td className="py-1 text-right tabular-nums">{fmt.amounts(row.wonAmounts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : null}
  </Card>
)
}

/** Item 14. What each campaign bought, and what it cost.
 *
 *  Visits and submissions are matched on the utm value that arrived, so anonymous
 *  traffic counts too. Contacts and deals go through first touch, which credits
 *  the campaign that found somebody rather than the one they last clicked. A
 *  cost-per is blank rather than zero when the campaign has no spend against it
 *  or reached nobody: dividing by nobody is not a cost of nothing. */
const Campaigns = async ({ rows }: { rows: CampaignPerformance[] }) => {
  const fmt = await getFormat()
  return (
  <Card title="Campaigns">
    {rows.length === 0 ? (
      <p className="max-w-prose text-secondary">
        No campaigns yet. Every utm_campaign the tracker sees is listed under Settings, Tracking,
        Campaigns; type the spend against one and its cost per contact and per deal appear here.
      </p>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-small">
          <thead>
            <tr className="border-b border-divider text-left text-secondary">
              <th scope="col" className="py-1 pr-3 font-medium">Campaign</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Spend</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Visits</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Submissions</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Contacts</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Deals</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Won</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Per contact</th>
              <th scope="col" className="py-1 text-right font-medium">Per deal</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-divider last:border-0">
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  <span className="break-words font-medium">{row.name}</span>
                  <span className="ml-2 break-all text-secondary">{row.utmCampaign}</span>
                </th>
                <td className="py-1 pr-3 text-right tabular-nums">{fmt.money(row.spend, row.currency)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{fmt.number(row.visits)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{fmt.number(row.submissions)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{fmt.number(row.contacts)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{fmt.number(row.deals)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{fmt.money(row.wonAmount, row.currency)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">
                  {row.costPerContact === null ? 'Not yet' : fmt.money(row.costPerContact, row.currency)}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {row.costPerDeal === null ? 'Not yet' : fmt.money(row.costPerDeal, row.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Card>
)
}

const AttributionReport = async ({
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
  const ctx = contextFrom(session)
  const [report, campaigns] = await Promise.all([
    attributionReport(ctx, range),
    campaignPerformance(ctx, range),
  ])
  const unattributed = report.first.find((row) => row.channel === 'Not attributed')

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReportsHeader account={account} current="attribution" from={range.fromDay} to={range.toDay} />

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

        <Campaigns rows={campaigns} />
      </div>
    </div>
  )
}

export default AttributionReport
