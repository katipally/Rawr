import Link from 'next/link'

/** A month of records, laid on the days a date field puts them.
 *
 *  Server-rendered and built from strings rather than Dates. The day a record
 *  belongs to was decided by Postgres; turning "2026-09-30" into a Date here and
 *  reading it back would move it to the 29th for every reader west of Greenwich,
 *  which is the bug the report axes had. Nothing in this file constructs a Date
 *  from a stored day. */

export type CalendarEntryView = {
  id: string
  displayName: string
  day: string
  time: string | null
  /** Where the square's chip goes. Built by the caller, because a month of deals
   *  and a month of meetings and tasks address entirely different things. */
  href: string
}

/** Monday-first, matching the ISO weeks the reports already use. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const partsOf = (day: string): { year: number; month: number; date: number } => ({
  year: Number(day.slice(0, 4)),
  month: Number(day.slice(5, 7)),
  date: Number(day.slice(8, 10)),
})

const iso = (year: number, month: number, date: number): string =>
  `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`

/** Days in a month, without a Date: the leap rule is four lines and a Date is a
 *  timezone. */
const daysIn = (year: number, month: number): number =>
  month === 2
    ? (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31

/** Which weekday the first falls on, Monday as 0. Zeller's, so no Date is built
 *  and no zone can shift it. */
const firstWeekday = (year: number, month: number): number => {
  const m = month < 3 ? month + 12 : month
  const y = month < 3 ? year - 1 : year
  const h = (1 + Math.floor((13 * (m + 1)) / 5) + y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400)) % 7
  // Zeller gives 0 for Saturday; shift so Monday is 0.
  return (h + 5) % 7
}

const monthLabel = (month: string): string => {
  const { year, month: index } = partsOf(month)
  return `${['January','February','March','April','May','June','July','August','September','October','November','December'][index - 1]} ${year}`
}

const shift = (month: string, by: 1 | -1): string => {
  const { year, month: index } = partsOf(month)
  const next = index + by
  if (next === 0) return iso(year - 1, 12, 1).slice(0, 7)
  if (next === 13) return iso(year + 1, 1, 1).slice(0, 7)
  return iso(year, next, 1).slice(0, 7)
}

/** More than fits a square without turning the row into a scrolling column. */
const PER_DAY = 3

export const CalendarGrid = ({
  month,
  today,
  entries,
  truncated,
  fieldLabel,
  monthHref,
}: {
  month: string
  /** The reader's own today, passed in rather than computed, so the highlight is
   *  their day and not the server's. */
  today: string
  entries: CalendarEntryView[]
  truncated: boolean
  /** What put the entries on their days, said under the month name. */
  fieldLabel: string
  /** Where Earlier and Later go. */
  monthHref: (month: string) => string
}) => {
  const { year, month: index } = partsOf(month)
  const total = daysIn(year, index)
  const lead = firstWeekday(year, index)

  const byDay = new Map<string, CalendarEntryView[]>()
  for (const entry of entries) {
    const list = byDay.get(entry.day)
    if (list) list.push(entry)
    else byDay.set(entry.day, [entry])
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link href={monthHref(shift(month, -1))} className="rounded-hs border border-line px-2 py-1 no-underline">
            ← Earlier
          </Link>
          <h2 className="font-medium">{monthLabel(month)}</h2>
          <Link href={monthHref(shift(month, 1))} className="rounded-hs border border-line px-2 py-1 no-underline">
            Later →
          </Link>
        </div>
        <p className="text-small text-secondary">Placed on {fieldLabel.toLowerCase()}</p>
      </div>

      {truncated ? (
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-small text-secondary">
          This month holds more than a calendar can draw. Narrow it with a filter, or read it as a
          list.
        </p>
      ) : null}

      {/* Scrolls rather than shrinking: seven columns below about forty rem each
          become unreadable, and a squashed calendar is worse than a scrolling one. */}
      <div className="overflow-x-auto">
        <div className="grid min-w-[44rem] grid-cols-7 gap-px rounded-panel border border-line bg-line">
          {WEEKDAYS.map((day) => (
            <div key={day} className="bg-surface px-2 py-1 text-small text-secondary">
              {day}
            </div>
          ))}

          {/* Blanks either side, so the month is a rectangle. Without the
              trailing ones the last row stops mid-way and the panel's border
              runs through empty space. */}
          {Array.from({ length: lead }, (_, at) => (
            <div key={`lead-${at}`} className="min-h-24 bg-canvas" />
          ))}

          {Array.from({ length: total }, (_, at) => {
            const date = at + 1
            const day = iso(year, index, date)
            const on = byDay.get(day) ?? []
            const isToday = day === today
            return (
              <div key={day} className="flex min-h-24 flex-col gap-0.5 bg-surface p-1">
                <span
                  className={
                    isToday
                      ? 'self-start rounded-full bg-accent px-1.5 text-small font-medium text-white tabular-nums'
                      : 'px-1.5 text-small text-secondary tabular-nums'
                  }
                >
                  {date}
                </span>
                {on.slice(0, PER_DAY).map((entry) => (
                  <Link
                    key={entry.id}
                    href={entry.href}
                    title={entry.displayName}
                    className="truncate rounded-hs bg-accent-subtle px-1.5 py-0.5 text-small text-link no-underline"
                  >
                    {entry.time ? `${entry.time} ` : ''}
                    {entry.displayName}
                  </Link>
                ))}
                {on.length > PER_DAY ? (
                  <span className="px-1.5 text-small text-secondary">
                    +{on.length - PER_DAY} more
                  </span>
                ) : null}
              </div>
            )
          })}

          {Array.from({ length: (7 - ((lead + total) % 7)) % 7 }, (_, at) => (
            <div key={`trail-${at}`} className="min-h-24 bg-canvas" />
          ))}
        </div>
      </div>
    </div>
  )
}
