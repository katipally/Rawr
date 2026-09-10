import { eventCountsByDay, listEventDefs } from '@rawr/db'
import { Card } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { BarChart } from '~/components/reports/chart.tsx'
import { contextFrom, readSession } from '~/server/session.ts'
import { ReportsHeader } from '../header.tsx'
import { reportRange } from '../range.ts'
import { FunnelBuilder } from './funnel-builder.tsx'

/** Item 13. What the tracked sites fired, and how far people got through a
 *  sequence of it.
 *
 *  Two questions, deliberately separate. The counts say what is happening at all;
 *  the funnel says where people stop, which is the only one anybody changes a
 *  product over. */
const EventsReport = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')
  const { account } = await params

  const ctx = contextFrom(session)
  const range = await reportRange(session, await searchParams)
  const [counts, defs] = await Promise.all([
    eventCountsByDay(ctx, range),
    listEventDefs(ctx, { limit: 100 }),
  ])

  const labelOf = new Map(defs.rows.map((row) => [row.name, row.label ?? row.name]))

  // One line per name is a chart nobody can read once there are twenty, so the
  // totals decide which names get a column and the rest are summed into the table
  // below by the same grouping.
  const totals = new Map<string, { events: number; visitors: number }>()
  for (const row of counts) {
    const running = totals.get(row.name) ?? { events: 0, visitors: 0 }
    totals.set(row.name, { events: running.events + row.events, visitors: running.visitors + row.visitors })
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1].events - a[1].events)
  const top = ranked.slice(0, 12)

  const days = [...new Set(counts.map((row) => row.day))].sort()
  const perDay = (name: string) => {
    const found = new Map(counts.filter((row) => row.name === name).map((row) => [row.day, row.events]))
    return days.map((day) => found.get(day) ?? 0)
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReportsHeader account={account} current="events" from={range.fromDay} to={range.toDay} />

      <div className="flex flex-col gap-4">
        <Card title="Events by day">
          {days.length === 0 ? (
            <p className="text-secondary">
              No custom event was fired in this range. Events arrive from the tracking snippet, and
              every name a site fires shows up under Settings, Tracking, Events on its own.
            </p>
          ) : (
            <BarChart
              title="Events by day"
              labels={days}
              series={top.slice(0, 4).map(([name], index) => ({
                label: labelOf.get(name) ?? name,
                values: perDay(name),
                tone: (['accent', 'success', 'warning', 'muted'] as const)[index] ?? 'muted',
              }))}
            />
          )}
        </Card>

        {ranked.length > 0 ? (
          <Card title="Every event in this range">
            <div className="overflow-x-auto">
              <table className="w-full text-small">
                <thead>
                  <tr className="border-b border-divider text-left text-secondary">
                    <th scope="col" className="py-1 pr-3 font-medium">Event</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Times fired</th>
                    <th scope="col" className="py-1 text-right font-medium">Visitors</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map(([name, count]) => (
                    <tr key={name} className="border-b border-divider last:border-0">
                      <th scope="row" className="py-1 pr-3 text-left font-normal">
                        <span className="break-words">{labelOf.get(name) ?? name}</span>
                        {labelOf.get(name) && labelOf.get(name) !== name ? (
                          <span className="ml-2 text-secondary">{name}</span>
                        ) : null}
                      </th>
                      <td className="py-1 pr-3 text-right tabular-nums">{count.events.toLocaleString()}</td>
                      <td className="py-1 text-right tabular-nums">{count.visitors.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        <FunnelBuilder
          from={range.from.toISOString()}
          to={range.to.toISOString()}
          names={defs.rows.map((row) => ({ name: row.name, label: row.label ?? row.name }))}
        />
      </div>
    </div>
  )
}

export default EventsReport
