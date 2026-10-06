/** HubSpot's rolling date ranges ("Last 30 days", "This quarter"). A saved filter
 *  stores the token with the `between` operator and the query resolves it against
 *  the day it is in the account's zone, so a view saved in March still means the
 *  last 30 days in June. Pure date arithmetic on "YYYY-MM-DD" keys, so a browser
 *  can label one and the compiler can resolve one from the same table.
 *
 *  Weeks start on Monday, the ISO week the rest of the data layer counts in. */

export type DateSpan = [first: string, last: string]

const keyOf = (year: number, month: number, day: number): string =>
  new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)

const partsOf = (key: string): [number, number, number] => {
  const [y = 1970, m = 1, d = 1] = key.split('-').map(Number)
  return [y, m, d]
}

const shift = (key: string, days: number): string => {
  const [y, m, d] = partsOf(key)
  return keyOf(y, m, d + days)
}

/** The period `offset` periods away from the one `today` is in, or that period
 *  up to today when `soFar`. Months, quarters and years are 1, 3 and 12 months. */
const period = (unit: 'week' | 'month' | 'quarter' | 'year', offset: number, soFar = false) => (today: string): DateSpan => {
  const [y, m, d] = partsOf(today)
  if (unit === 'week') {
    const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
    const first = shift(today, offset * 7 - weekday)
    return [first, soFar ? today : shift(first, 6)]
  }
  const span = unit === 'month' ? 1 : unit === 'quarter' ? 3 : 12
  const start = unit === 'year' ? 1 : m - ((m - 1) % span)
  const first = keyOf(y, start + offset * span, 1)
  // Day 0 of a month is the last day of the one before it.
  return [first, soFar ? today : keyOf(y, start + (offset + 1) * span, 0)]
}

const lastDays = (count: number) => (today: string): DateSpan => [shift(today, -count), shift(today, -1)]

const day = (offset: number) => (today: string): DateSpan => {
  const key = shift(today, offset)
  return [key, key]
}

export const DATE_RANGES = [
  { token: '@today', label: 'Today', span: day(0) },
  { token: '@yesterday', label: 'Yesterday', span: day(-1) },
  { token: '@tomorrow', label: 'Tomorrow', span: day(1) },
  { token: '@this_week', label: 'This week', span: period('week', 0) },
  { token: '@this_week_so_far', label: 'This week so far', span: period('week', 0, true) },
  { token: '@last_week', label: 'Last week', span: period('week', -1) },
  { token: '@next_week', label: 'Next week', span: period('week', 1) },
  { token: '@this_month', label: 'This month', span: period('month', 0) },
  { token: '@this_month_so_far', label: 'This month so far', span: period('month', 0, true) },
  { token: '@last_month', label: 'Last month', span: period('month', -1) },
  { token: '@next_month', label: 'Next month', span: period('month', 1) },
  { token: '@this_quarter', label: 'This quarter', span: period('quarter', 0) },
  { token: '@this_quarter_so_far', label: 'This quarter so far', span: period('quarter', 0, true) },
  { token: '@last_quarter', label: 'Last quarter', span: period('quarter', -1) },
  { token: '@next_quarter', label: 'Next quarter', span: period('quarter', 1) },
  { token: '@this_year', label: 'This year', span: period('year', 0) },
  { token: '@this_year_so_far', label: 'This year so far', span: period('year', 0, true) },
  { token: '@last_year', label: 'Last year', span: period('year', -1) },
  { token: '@next_year', label: 'Next year', span: period('year', 1) },
  { token: '@last_7_days', label: 'Last 7 days', span: lastDays(7) },
  { token: '@last_14_days', label: 'Last 14 days', span: lastDays(14) },
  { token: '@last_30_days', label: 'Last 30 days', span: lastDays(30) },
  { token: '@last_60_days', label: 'Last 60 days', span: lastDays(60) },
  { token: '@last_90_days', label: 'Last 90 days', span: lastDays(90) },
  { token: '@last_180_days', label: 'Last 180 days', span: lastDays(180) },
  { token: '@last_365_days', label: 'Last 365 days', span: lastDays(365) },
] as const

export type DateRangeToken = (typeof DATE_RANGES)[number]['token']

const BY_TOKEN = new Map<string, (typeof DATE_RANGES)[number]>(DATE_RANGES.map((range) => [range.token, range]))

export const isDateRange = (value: unknown): value is DateRangeToken => typeof value === 'string' && BY_TOKEN.has(value)

export const dateRangeLabel = (token: DateRangeToken): string => BY_TOKEN.get(token)!.label

/** First and last day of the range, both inclusive, as seen on `today`. */
export const resolveDateRange = (token: DateRangeToken, today: string): DateSpan => BY_TOKEN.get(token)!.span(today)
