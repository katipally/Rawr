import type { Format } from './format.ts'

/** A report range as the viewer reads it. The year is written only when it is
 *  needed to tell the days apart: a range in this year reads "Oct 1 to Oct 7", and
 *  anything else (a past year, or a range across New Year) writes the year on both
 *  ends. A single day is one date, never "Oct 7 to Oct 7". Days are YYYY-MM-DD. */
export const rangeLabel = (from: string, to: string, today: string, fmt: Format): string => {
  const thisYear = today.slice(0, 4)
  const withYear = from.slice(0, 4) !== thisYear || to.slice(0, 4) !== thisYear
  const show = (day: string) => (withYear ? fmt.date(day) : fmt.dayShort(day))
  return from === to ? show(from) : `${show(from)} to ${show(to)}`
}
