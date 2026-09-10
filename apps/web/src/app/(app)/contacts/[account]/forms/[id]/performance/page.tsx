import { formPerformance, getForm } from '@rawr/db'
import { Breadcrumb, Card, Tabs } from '@rawr/ui'
import { notFound, redirect } from 'next/navigation'
import { formatDayShort } from '~/components/crm/value.tsx'
import { RangePicker } from '~/components/reports/range-picker.tsx'
import { formPerformancePath, formsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { reportRange } from '../../../reports/range.ts'
import { PerformanceCharts } from './charts.tsx'

/** What one form did, over a range somebody chose.
 *
 *  Four questions, in the order they get asked: how many people saw it, how many
 *  of them filled it in, where those people were, and where they came from. The
 *  funnel between the first two is the part the browser has to report, because
 *  nothing on the server can tell a page that loaded from a form that appeared. */

const PerformancePage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; id: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}) => {
  const { account, id } = await params
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  const range = await reportRange(session, await searchParams)
  const [form, report] = await Promise.all([
    getForm(ctx, id),
    formPerformance(ctx, { formId: id, from: range.fromDay, to: range.toDay }),
  ])
  if (!form || !report) notFound()

  const conversion = report.totals.views === 0 ? null : report.totals.submissions / report.totals.views
  const delta =
    report.previousViews === 0
      ? null
      : (report.totals.views - report.previousViews) / report.previousViews

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-col gap-2">
        <Breadcrumb items={[{ label: 'Forms', href: formsPath(account) }, { label: form.name }]} />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="min-w-0 break-words text-lg font-medium">{form.name}</h1>
          <RangePicker from={range.fromDay} to={range.toDay} />
        </div>
        <Tabs
          label="Form"
          items={[
            { key: 'edit', label: 'Edit', href: formsPath(account, id) },
            {
              key: 'performance',
              label: 'Performance',
              href: formPerformancePath(account, id),
              current: true,
            },
          ]}
        />
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Tile
          label="Views"
          value={report.totals.views.toLocaleString()}
          detail={
            delta === null
              ? 'Nothing to compare with in the period before this one.'
              : `${delta >= 0 ? '+' : ''}${Math.round(delta * 100)}% against the ${report.days.length} days before this range`
          }
        />
        <Tile
          label="Conversion rate"
          value={conversion === null ? '—' : `${(conversion * 100).toFixed(1)}%`}
          detail="Submissions as a share of the times the form appeared."
        />
        <Tile
          label="Submissions"
          value={report.totals.submissions.toLocaleString()}
          detail="Kept submissions. Held and spam are on the list."
        />
      </div>

      <PerformanceCharts
        days={report.days.map((row) => ({ ...row, label: formatDayShort(row.day) }))}
        funnel={[
          { id: 'visits', label: 'Page visits', value: report.totals.pageVisits },
          { id: 'renders', label: 'Visible on page', value: report.totals.renders },
          { id: 'interactions', label: 'Interacted with form', value: report.totals.interactions },
          { id: 'submissions', label: 'Submitted', value: report.totals.submissions },
        ]}
        contactType={report.contactType}
      />

      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <Card title="Conversion pages">
          <Breakdown
            first="Page"
            rows={report.pages.map((row) => ({ key: row.path, label: row.path, views: row.views, submissions: row.submissions }))}
            empty="The form has not been seen on any page in this range."
          />
          <p className="mt-2 max-w-prose text-small text-secondary">
            Where the form appeared, by path. The hosted page counts as its own
            address, which is how a form that is only ever opened from a link still
            has a row here.
          </p>
        </Card>

        <Card title="Submissions by source">
          <Breakdown
            first="Source"
            rows={report.sources.map((row) => ({ key: row.channel, label: row.channel, views: row.views, submissions: row.submissions }))}
            empty="Nobody arrived through a session we could attribute in this range."
          />
          <p className="mt-2 max-w-prose text-small text-secondary">
            The channel of the session the visitor was in. &ldquo;Unknown&rdquo; is a
            submission with no session behind it: somebody who declined analytics, or
            who opened the hosted page directly.
          </p>
        </Card>
      </div>

      {report.appearsOn.length > 0 ? (
        <Card title={`Appears on ${report.appearsOn.length} ${report.appearsOn.length === 1 ? 'page' : 'pages'}`}>
          <ul className="m-0 flex flex-wrap gap-1 p-0">
            {report.appearsOn.map((path) => (
              <li key={path} className="min-w-0 list-none break-all rounded-pill border border-line px-2 py-0.5 text-small text-secondary">
                {path}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}

const Tile = ({ label, value, detail }: { label: string; value: string; detail: string }) => (
  <div className="flex min-w-0 flex-col gap-1 rounded-panel border border-line bg-surface p-3">
    <span className="text-small text-secondary">{label}</span>
    <span className="break-words text-lg font-medium tabular-nums">{value}</span>
    <span className="text-small text-secondary">{detail}</span>
  </div>
)

const Breakdown = ({
  first,
  rows,
  empty,
}: {
  first: string
  rows: { key: string; label: string; views: number; submissions: number }[]
  empty: string
}) =>
  rows.length === 0 ? (
    <p className="text-secondary">{empty}</p>
  ) : (
    <div className="overflow-x-auto">
      <table className="w-full text-small">
        <thead>
          <tr className="border-b border-divider text-left text-secondary">
            <th scope="col" className="py-1 pr-3 font-medium">{first}</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Views</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Submissions</th>
            <th scope="col" className="py-1 text-right font-medium">Conversion rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-divider last:border-0">
              <th scope="row" className="min-w-0 break-all py-1 pr-3 text-left font-normal">{row.label}</th>
              <td className="py-1 pr-3 text-right tabular-nums">{row.views.toLocaleString()}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{row.submissions.toLocaleString()}</td>
              <td className="py-1 text-right tabular-nums">
                {row.views === 0 ? '—' : `${((row.submissions / row.views) * 100).toFixed(1)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

export default PerformancePage
