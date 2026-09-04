import { clampRange, type Range } from '@rawr/db'

/** The range every report page reads out of its own URL. One place, so a link
 *  pasted between two reports means the same thing in both. */

export type RangeParams = { from?: string | undefined; to?: string | undefined }

const iso = (date: Date): string => date.toISOString().slice(0, 10)

export const rangeFrom = (params: RangeParams): Range & { fromDay: string; toDay: string } => {
  // A date with no time means the whole of that day, so the end is exclusive at
  // midnight the following morning rather than excluding the day it names.
  const to = params.to ? new Date(`${params.to}T00:00:00Z`) : new Date()
  if (params.to) to.setUTCDate(to.getUTCDate() + 1)
  const range = clampRange({
    from: params.from ? `${params.from}T00:00:00Z` : null,
    to: to.toISOString(),
  })
  const lastDay = new Date(range.to.getTime() - 1)
  return { ...range, fromDay: iso(range.from), toDay: iso(lastDay) }
}
