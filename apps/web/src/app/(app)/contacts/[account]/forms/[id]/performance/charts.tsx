'use client'

import { Card, Select } from '@rawr/ui'
import { useState } from 'react'
import { BarChart, Donut, Funnel, type FunnelStep } from '~/components/reports/chart.tsx'

/** The three shapes that need a click: a series whose metric the reader picks,
 *  the step funnel, and the split between people we already had and people this
 *  form introduced. */

type Day = { day: string; label: string; views: number; submissions: number }

const METRICS = [
  { key: 'conversion', label: 'Conversion rate' },
  { key: 'views', label: 'Form views' },
  { key: 'submissions', label: 'Submissions' },
] as const

type Metric = (typeof METRICS)[number]['key']

export const PerformanceCharts = ({
  days,
  funnel,
  contactType,
}: {
  days: Day[]
  funnel: FunnelStep[]
  contactType: { existing: number; created: number }
}) => {
  const [metric, setMetric] = useState<Metric>('conversion')

  // A rate is a percentage with one decimal; the other two are counts. Kept as
  // whole numbers in the series either way, because the chart draws integers and
  // a tenth of a percent is a tenth of a unit here.
  const values = days.map((day) =>
    metric === 'views'
      ? day.views
      : metric === 'submissions'
        ? day.submissions
        : day.views === 0
          ? 0
          : Math.round((day.submissions / day.views) * 1000) / 10,
  )

  const label = METRICS.find((entry) => entry.key === metric)?.label ?? 'Conversion rate'

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      <Card>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <p className="font-medium">By session date</p>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-small text-secondary">Metric</span>
            <Select value={metric} onChange={(event) => setMetric(event.target.value as Metric)}>
              {METRICS.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <BarChart
          title={label}
          labels={days.map((day) => day.label)}
          series={[{ label, values, tone: 'accent' }]}
          format={(value) => (metric === 'conversion' ? `${value}%` : value.toLocaleString())}
        />
      </Card>

      <Card>
        <Funnel title="Step completion" steps={funnel} />
        <p className="mt-2 max-w-prose text-small text-secondary">
          The middle two steps are reported by the embed as it paints and as somebody
          first touches a field. A form only ever opened on its hosted page has no
          separate page visit, so the first two steps there are the same number.
        </p>
      </Card>

      <Card>
        <Donut
          title="Contact type"
          slices={[
            { id: 'existing', label: 'Existing contacts', value: contactType.existing, tone: 'muted' },
            { id: 'created', label: 'New contacts', value: contactType.created, tone: 'accent' },
          ]}
        />
        <p className="mt-2 max-w-prose text-small text-secondary">
          A submission counts as new when the contact behind it was created by that
          submission. A returning person filling the form again is an existing contact,
          not a second one.
        </p>
      </Card>
    </div>
  )
}
