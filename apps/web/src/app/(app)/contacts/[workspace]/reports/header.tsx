import { PageHeader, Tabs } from '@rawr/ui'
import { RangePicker } from '~/components/reports/range-picker.tsx'
import { reportsPath } from '~/lib/links.ts'

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
  { key: 'attribution', label: 'Attribution' },
  { key: 'dashboards', label: 'Dashboards' },
]

export const ReportsHeader = ({
  workspace,
  current,
  from,
  to,
}: {
  workspace: string
  /** The tab's own key: '' for the overview. */
  current: string
  from: string
  to: string
}) => (
  <>
    <PageHeader
      title="Reports"
      lead={`${from} to ${to}`}
      why="Every chart carries the same figures as a table underneath it, so a number can be read off rather than estimated from a shape. The range lives in the URL, which means a link to a report is a link to the period somebody was looking at."
      action={<RangePicker from={from} to={to} />}
    />

    <div className="border-b border-divider">
      <Tabs
        label="Reports"
        items={TABS.map((tab) => ({
          key: tab.key || 'overview',
          label: tab.label,
          href: reportsPath(workspace, { ...(tab.key ? { tab: tab.key } : {}), from, to }),
          current: current === tab.key,
        }))}
      />
    </div>
  </>
)
