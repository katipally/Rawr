import { MAX_DAYS } from '@rawr/db'
import { PageHeader, Tabs } from '@rawr/ui'
import { RangePicker } from '~/components/reports/range-picker.tsx'
import { reportsPath } from '~/lib/links.ts'
import { rangeLabel } from '~/lib/range-label.ts'
import { getFormat } from '~/server/format.ts'

/** The frame around all six reports: which one is open, and over what range.
 *
 *  Rendered by each page rather than by the layout, because Next passes
 *  searchParams to pages only. Reading it in a layout hands you undefined, and the
 *  range is the whole point of this bar. */

const TABS = [
  { key: '', label: 'Overview' },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'forms', label: 'Forms' },
  { key: 'sequences', label: 'Sequences' },
  { key: 'email', label: 'Email' },
  { key: 'website', label: 'Website' },
  { key: 'events', label: 'Events' },
  { key: 'attribution', label: 'Attribution' },
  { key: 'dashboards', label: 'Dashboards' },
]

export const ReportsHeader = async ({
  account,
  current,
  from,
  to,
  clipped,
}: {
  account: string
  /** The tab's own key: '' for the overview. */
  current: string
  from: string
  to: string
  /** The range was longer than the reports cover, and was cut to its last MAX_DAYS. */
  clipped: boolean
}) => {
  const fmt = await getFormat()
  const label = rangeLabel(from, to, fmt.today(), fmt)
  return (
    <>
      <PageHeader
        title="Reports"
        lead={clipped ? `${label}. Reports cover at most ${MAX_DAYS} days, so this range was cut to its most recent ${MAX_DAYS}.` : label}
        why="Every chart carries the same figures as a table underneath it, so a number can be read off rather than estimated from a shape. The range lives in the URL, which means a link to a report is a link to the period somebody was looking at."
        action={<RangePicker from={from} to={to} />}
      />

      <div className="border-b border-divider">
        <Tabs
          label="Reports"
          items={TABS.map((tab) => ({
            key: tab.key || 'overview',
            label: tab.label,
            href: reportsPath(account, { ...(tab.key ? { tab: tab.key } : {}), from, to }),
            current: current === tab.key,
          }))}
        />
      </div>
    </>
  )
}
