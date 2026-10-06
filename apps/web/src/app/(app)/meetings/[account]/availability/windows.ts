/** HubSpot's availability window rows ("Mon - Fri from 9:00 AM to 5:00 PM")
 *  over the per-day map the schedule is stored as. A row for a group of days
 *  writes the same range into each of them; a stored map is read back into the
 *  fewest rows, so a week of identical weekdays is one row and not five. */

export type Ranges = Record<string, [string, string][]>

export type DayGroup = 'every' | 'weekdays' | 'weekends' | '1' | '2' | '3' | '4' | '5' | '6' | '7'

export type Window = { key: string; days: DayGroup; from: string; to: string }

export const DAY_GROUPS: { value: DayGroup; label: string; days: string[] }[] = [
  { value: 'every', label: 'Every day', days: ['1', '2', '3', '4', '5', '6', '7'] },
  { value: 'weekdays', label: 'Mon - Fri', days: ['1', '2', '3', '4', '5'] },
  { value: 'weekends', label: 'Sat - Sun', days: ['6', '7'] },
  { value: '1', label: 'Monday', days: ['1'] },
  { value: '2', label: 'Tuesday', days: ['2'] },
  { value: '3', label: 'Wednesday', days: ['3'] },
  { value: '4', label: 'Thursday', days: ['4'] },
  { value: '5', label: 'Friday', days: ['5'] },
  { value: '6', label: 'Saturday', days: ['6'] },
  { value: '7', label: 'Sunday', days: ['7'] },
]

const GROUP_DAYS = new Map(DAY_GROUPS.map((group) => [group.value, group.days]))
const ORDER = new Map(DAY_GROUPS.map((group, index) => [group.value, index]))

/** The fewest rows that write `weekly` back exactly: each distinct range takes
 *  Every day, then Mon - Fri, then Sat - Sun where all of their days have it,
 *  and single days for the rest. O(days x ranges). */
export const toWindows = (weekly: Ranges, key: () => string): Window[] => {
  const byRange = new Map<string, Set<string>>()
  for (const [day, ranges] of Object.entries(weekly)) {
    for (const [from, to] of ranges) {
      const range = `${from}-${to}`
      byRange.set(range, (byRange.get(range) ?? new Set()).add(day))
    }
  }
  const rows: Window[] = []
  for (const [range, days] of byRange) {
    const [from = '', to = ''] = range.split('-')
    for (const group of DAY_GROUPS) {
      if (group.days.every((day) => days.has(day))) {
        rows.push({ key: key(), days: group.value, from, to })
        for (const day of group.days) days.delete(day)
      }
    }
  }
  return rows.sort((a, b) => a.from.localeCompare(b.from) || (ORDER.get(a.days) ?? 0) - (ORDER.get(b.days) ?? 0))
}

/** The per-day map the rows describe, each day's ranges in start order with a
 *  range two rows both gave it kept once. Days with nothing are left out, which
 *  is how the stored map says not working. O(rows x 7). */
export const toWeekly = (rows: Window[]): Ranges => {
  const weekly: Ranges = {}
  for (const row of rows) {
    for (const day of GROUP_DAYS.get(row.days) ?? []) {
      const ranges = weekly[day] ?? []
      if (!ranges.some(([from, to]) => from === row.from && to === row.to)) ranges.push([row.from, row.to])
      weekly[day] = ranges
    }
  }
  for (const ranges of Object.values(weekly)) ranges.sort((a, b) => a[0].localeCompare(b[0]))
  return weekly
}

/** Days whose hours differ between two maps, an absent day reading as none. */
export const daysChanged = (a: Ranges, b: Ranges): number =>
  DAY_GROUPS[0]!.days.filter((day) => JSON.stringify(a[day] ?? []) !== JSON.stringify(b[day] ?? [])).length
