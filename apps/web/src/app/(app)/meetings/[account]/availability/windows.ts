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

/** Windows edited since the save: a row whose days or hours differ from the one
 *  with its key, a row with a new key, and a saved row no longer present. A
 *  person who edits one window's end time has made one change, however many days
 *  that window covers. O(rows). */
export const windowsChanged = (rows: Window[], saved: Window[]): number => {
  const before = new Map(saved.map((row) => [row.key, row]))
  const kept = new Set(rows.map((row) => row.key))
  let changed = saved.filter((row) => !kept.has(row.key)).length
  for (const row of rows) {
    const was = before.get(row.key)
    if (!was || was.days !== row.days || was.from !== row.from || was.to !== row.to) changed++
  }
  return changed
}

const minuteOf = (clock: string): number => {
  const [hours = 0, minutes = 0] = clock.split(':').map(Number)
  return hours * 60 + minutes
}

/** Hours a week across every day. Ranges that overlap or touch are merged first, so
 *  nine to one and nine to five is eight hours, not twelve. O(n log n) per day. */
export const weeklyHours = (weekly: Ranges): number => {
  let minutes = 0
  for (const ranges of Object.values(weekly)) {
    const spans = ranges.map(([from, to]) => [minuteOf(from), minuteOf(to)] as const).sort((a, b) => a[0] - b[0])
    let start = -1
    let end = -1
    for (const [from, to] of spans) {
      if (to <= from) continue
      if (from > end) {
        minutes += end - start
        start = from
        end = to
      } else {
        end = Math.max(end, to)
      }
    }
    minutes += end - start
  }
  return Math.round((minutes / 60) * 10) / 10
}
