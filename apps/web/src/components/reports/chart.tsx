import { cn } from '@rawr/ui'
import { AxisLabels } from './axis-labels.tsx'

/** B7's charts. SVG drawn from the design tokens, no charting library.
 *
 *  Three shapes cover every report here, and each one ships the same numbers twice:
 *  once as a picture and once as a real table, visible below it. That is not a
 *  fallback for a screen reader bolted on afterwards. A bar whose value somebody
 *  has to estimate by eye is a worse answer than the number, and a report people
 *  copy figures out of needs the figures to be selectable text. */

export type Series = { label: string; values: number[]; tone: Tone }
export type Tone = 'accent' | 'success' | 'warning' | 'error' | 'muted'

const STROKE: Record<Tone, string> = {
  accent: 'var(--color-accent)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  error: 'var(--color-error)',
  muted: 'var(--color-secondary)',
}

const nice = (value: number): string =>
  Math.abs(value) >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(value)

/** The largest value across every series, rounded up so the tallest bar does not
 *  touch the top edge. Zero everywhere gives 1, so an empty chart draws a flat
 *  baseline rather than dividing by nothing. */
const ceiling = (series: Series[]): number =>
  Math.max(1, ...series.flatMap((entry) => entry.values))

export type ChartProps = {
  title: string
  /** One per column, in order. Long lists thin out their labels rather than
   *  overlapping them. */
  labels: string[]
  series: Series[]
  /** How each value reads in the table below: a count, or money. */
  format?: (value: number) => string
  className?: string
}

const Legend = ({ series }: { series: Series[] }) => (
  <ul className="flex flex-wrap gap-x-4 gap-y-1">
    {series.map((entry) => (
      <li key={entry.label} className="flex items-center gap-1.5 text-small text-secondary">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full"
          style={{ background: STROKE[entry.tone] }}
        />
        {entry.label}
      </li>
    ))}
  </ul>
)

const Table = ({
  labels,
  series,
  format,
  caption,
}: {
  labels: string[]
  series: Series[]
  format: (value: number) => string
  caption: string
}) => (
  <div className="overflow-x-auto">
    <table className="w-full text-small">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-divider text-left text-secondary">
          <th scope="col" className="py-1 pr-3 font-medium">
            &nbsp;
          </th>
          {series.map((entry) => (
            <th key={entry.label} scope="col" className="py-1 pr-3 text-right font-medium">
              {entry.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {labels.map((label, index) => (
          // A category axis is positional, and the labels are user data: two
          // sequences may share a name. The column number is the identity.
          <tr key={index} className="border-b border-divider last:border-0">
            <th scope="row" className="py-1 pr-3 text-left font-normal">
              {label}
            </th>
            {series.map((entry) => (
              <td key={entry.label} className="py-1 pr-3 text-right tabular-nums">
                {format(entry.values[index] ?? 0)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

/** Grouped bars over time or over categories.
 *
 *  The bars are an SVG stretched to the container, because bars should fill the
 *  width they are given. The labels are HTML underneath it rather than text inside
 *  it: a stretched SVG scales its text with it, which turns a three-column chart
 *  into distorted letterforms. How many of them are drawn is measured in the
 *  browser; see AxisLabels. */
export const BarChart = ({ title, labels, series, format = nice, className }: ChartProps) => {
  const top = ceiling(series)
  const columns = labels.length
  const height = 180
  // A unit grid: one unit per column, so the widths do not depend on the pixel
  // size the container happens to give it.
  const width = Math.max(1, columns) * 100
  const groupWidth = 100
  // A wide gap when there are few columns: two bars stretched across a whole card
  // read as a block of colour rather than as a comparison.
  const gap = columns <= 3 ? 55 : columns <= 6 ? 35 : 12
  const barWidth = (groupWidth - gap) / Math.max(1, series.length)

  return (
    <figure className={cn('flex min-w-0 flex-col gap-2', className)}>
      <figcaption className="font-medium">{title}</figcaption>
      <Legend series={series} />

      {columns === 0 ? (
        <p className="py-6 text-center text-secondary">Nothing in this range.</p>
      ) : (
        <>
          <div className="min-w-0">
            <svg
              role="img"
              aria-label={`${title}. The same numbers are in the table below.`}
              viewBox={`0 0 ${width} ${height}`}
              className="h-48 w-full"
              preserveAspectRatio="none"
            >
              <line
                x1={0}
                y1={height}
                x2={width}
                y2={height}
                stroke="var(--color-divider)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              {labels.map((label, column) => (
                <g key={column}>
                  {series.map((entry, index) => {
                    const value = entry.values[column] ?? 0
                    const barHeight = Math.max(value === 0 ? 0 : 2, (value / top) * (height - 4))
                    return (
                      <rect
                        key={entry.label}
                        x={column * groupWidth + gap / 2 + index * barWidth}
                        y={height - barHeight}
                        width={Math.max(1, barWidth - 2)}
                        height={barHeight}
                        fill={STROKE[entry.tone]}
                      >
                        <title>{`${label} · ${entry.label}: ${format(value)}`}</title>
                      </rect>
                    )
                  })}
                </g>
              ))}
            </svg>

            <AxisLabels labels={labels} />
          </div>

          <Table labels={labels} series={series} format={format} caption={title} />
        </>
      )}
    </figure>
  )
}

/** `id` rather than the label as the React key: two pipelines may both have a
 *  stage called "Closed Won", and identifying a step by its text silently merged
 *  them. */
export type FunnelStep = { id: string; label: string; value: number; detail?: string | undefined }

/** A funnel, drawn as proportional bars rather than a tapering polygon. A trapezoid
 *  makes a step look smaller than the one above it even when it is larger, which is
 *  the one thing a funnel must not do. */
export const Funnel = ({
  title,
  steps,
  format = nice,
  className,
}: {
  title: string
  steps: FunnelStep[]
  format?: (value: number) => string
  className?: string
}) => {
  const top = Math.max(1, ...steps.map((step) => step.value))

  return (
    <figure className={cn('flex min-w-0 flex-col gap-2', className)}>
      <figcaption className="font-medium">{title}</figcaption>
      {steps.length === 0 ? (
        <p className="py-6 text-center text-secondary">Nothing in this range.</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {steps.map((step, index) => (
            <li key={step.id} className="flex min-w-0 flex-col gap-0.5">
              <p className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="min-w-0 font-medium">{step.label}</span>
                <span className="text-small text-secondary tabular-nums">
                  {format(step.value)}
                  {step.detail ? ` · ${step.detail}` : ''}
                  {index > 0 && (steps[index - 1]?.value ?? 0) > 0
                    ? ` · ${Math.round((step.value / (steps[index - 1]?.value ?? 1)) * 100)}% of the step above`
                    : ''}
                </span>
              </p>
              <div className="h-2 w-full rounded-full bg-fill">
                <div
                  className="h-2 rounded-full"
                  style={{ width: `${(step.value / top) * 100}%`, background: 'var(--color-accent)' }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </figure>
  )
}

export type Slice = { id: string; label: string; value: number; tone: Tone }

/** A ring, for a split of one whole into two or three parts.
 *
 *  The only shape here that encodes a value as an angle, and it earns that on one
 *  condition: the parts add up to something, and there are few enough of them
 *  that nobody has to compare two arcs by eye. The numbers are beside it, in the
 *  legend, for the times somebody does. */
export const Donut = ({
  title,
  slices,
  format = nice,
  className,
}: {
  title: string
  slices: Slice[]
  format?: (value: number) => string
  className?: string
}) => {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  // A unit circle: the radius the ring is drawn at, and the circumference the
  // dash offsets are measured in. Everything else scales with the container.
  const radius = 40
  const circumference = 2 * Math.PI * radius
  let offset = 0

  return (
    <figure className={cn('flex min-w-0 flex-col gap-2', className)}>
      <figcaption className="font-medium">{title}</figcaption>
      {total === 0 ? (
        <p className="py-6 text-center text-secondary">Nothing in this range.</p>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <svg
            role="img"
            aria-label={`${title}. The same numbers are in the legend beside it.`}
            viewBox="0 0 100 100"
            className="h-32 w-32 shrink-0 -rotate-90"
          >
            {slices.map((slice) => {
              const length = (slice.value / total) * circumference
              const start = offset
              offset += length
              return (
                <circle
                  key={slice.id}
                  cx={50}
                  cy={50}
                  r={radius}
                  fill="none"
                  stroke={STROKE[slice.tone]}
                  strokeWidth={16}
                  strokeDasharray={`${length} ${circumference - length}`}
                  strokeDashoffset={-start}
                >
                  <title>{`${slice.label}: ${format(slice.value)}`}</title>
                </circle>
              )
            })}
          </svg>
          <ul className="flex min-w-0 flex-col gap-1">
            {slices.map((slice) => (
              <li key={slice.id} className="flex min-w-0 items-baseline gap-2 text-small">
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: STROKE[slice.tone] }}
                />
                <span className="min-w-0 break-words">{slice.label}</span>
                <span className="ml-auto shrink-0 text-secondary tabular-nums">
                  {format(slice.value)} · {Math.round((slice.value / total) * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </figure>
  )
}
