/** F2 §2. The availability arithmetic, with no database and no clock of its own.
 *
 *  Everything a slot depends on arrives as an argument, including `now`, because
 *  the cases that break scheduling code are all about specific instants: a
 *  spring-forward weekend, a host in Los Angeles and a booker in Kathmandu, a
 *  window that ends at midnight. A function that reads the wall clock itself
 *  cannot be asked about any of them.
 *
 *  Times of day are wall-clock rules in a named zone, resolved against a date.
 *  That is what keeps 9am at 9am through a DST change, which an offset cannot. */

export type Interval = { start: Date; end: Date }

/** Local times as "HH:MM", inclusive start, exclusive end. "24:00" is the end of
 *  the day; an end at or before the start is read as crossing midnight. */
export type TimeRange = [string, string]

/** Keyed by ISO weekday as a string, 1 = Monday through 7 = Sunday. Strings
 *  because this is JSONB and JSON object keys are strings. */
export type WeeklyRules = Record<string, TimeRange[]>

export type DayOverride = { isUnavailable: boolean; blocks: TimeRange[] }

const MINUTE = 60_000
const DAY = 86_400_000

// ---------------------------------------------------------------------------
// Timezones
// ---------------------------------------------------------------------------

/** Intl.DateTimeFormat construction is the expensive part of every conversion
 *  below, and a month of slots for five hosts asks for the same handful of zones
 *  thousands of times. Bounded by the number of distinct zones in use, which is
 *  the number of hosts plus one. */
const formatters = new Map<string, Intl.DateTimeFormat>()

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const held = formatters.get(timeZone)
  if (held) return held
  // Throws on an unknown zone, which is what we want: a page whose host has a
  // mistyped timezone must fail loudly rather than quietly offer UTC.
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  formatters.set(timeZone, made)
  return made
}

export const isKnownTimezone = (timeZone: string): boolean => {
  try {
    formatterFor(timeZone)
    return true
  } catch {
    return false
  }
}

export type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export const zonedParts = (at: Date, timeZone: string): ZonedParts => {
  const parts = formatterFor(timeZone).formatToParts(at)
  const read = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value ?? '0'
    return Number(value)
  }
  // Hour 24 appears for midnight in some ICU versions with hour12:false.
  const hour = read('hour') % 24
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour,
    minute: read('minute'),
    second: read('second'),
  }
}

/** The zone's offset from UTC at that instant, in milliseconds. Read by formatting
 *  the instant in the zone and treating the result as if it were UTC: the gap
 *  between that and the real instant is the offset. */
export const offsetMs = (at: Date, timeZone: string): number => {
  const p = zonedParts(at, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // The instant carries milliseconds the formatter does not report; drop them from
  // both sides so the difference is a whole-second offset.
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** "YYYY-MM-DD" for the calendar date that instant falls on, in that zone. The
 *  key an override is stored under. */
export const dayKey = (at: Date, timeZone: string): string => {
  const p = zonedParts(at, timeZone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** ISO weekday, 1 = Monday. Derived from the zone's own calendar date rather than
 *  the instant's UTC weekday, which differ for most of the day in most of Asia. */
export const isoWeekday = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number)
  const utc = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))
  return utc.getUTCDay() === 0 ? 7 : utc.getUTCDay()
}

export const addDays = (key: string, days: number): string => {
  const [y, m, d] = key.split('-').map(Number)
  const utc = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * DAY)
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(
    utc.getUTCDate(),
  ).padStart(2, '0')}`
}

/** A wall-clock time on a calendar date in a zone, as an instant.
 *
 *  Two passes: guess with the offset that applies at the naive instant, then
 *  re-read the offset at the answer and correct. That is what gets the hour either
 *  side of a DST transition right, where the offset before and after differ.
 *
 *  A wall time that does not exist (the hour skipped by spring forward) resolves
 *  to the instant the clock jumps to. The window shifts forward by the gap instead
 *  of the day silently disappearing, which is the honest failure: the host said
 *  they work that morning. */
export const zonedTimeToUtc = (key: string, minutesOfDay: number, timeZone: string): Date => {
  const [y, m, d] = key.split('-').map(Number)
  const naive =
    Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + Math.trunc(minutesOfDay) * MINUTE
  const firstGuess = naive - offsetMs(new Date(naive), timeZone)
  const corrected = naive - offsetMs(new Date(firstGuess), timeZone)
  return new Date(corrected)
}

/** "HH:MM" to minutes past midnight. "24:00" is 1440. Returns null on anything
 *  that is not a time, so a hand-edited schedule drops the bad window rather than
 *  producing NaN slots. */
export const minutesOfDay = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 24 || minutes > 59) return null
  const total = hours * 60 + minutes
  return total > 1440 ? null : total
}

export const formatMinutes = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`

// ---------------------------------------------------------------------------
// Interval arithmetic
// ---------------------------------------------------------------------------

/** Sorted and coalesced, so everything downstream can assume one pass is enough.
 *  O(n log n) on the sort, O(n) after. */
export const mergeIntervals = (intervals: Interval[]): Interval[] => {
  const sorted = intervals
    .filter((i) => i.end.getTime() > i.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime())

  const merged: Interval[] = []
  for (const next of sorted) {
    const last = merged.at(-1)
    if (last && next.start.getTime() <= last.end.getTime()) {
      if (next.end.getTime() > last.end.getTime()) last.end = next.end
      continue
    }
    merged.push({ start: next.start, end: next.end })
  }
  return merged
}

/** base minus cuts. Both are merged first, then walked together once, so this is
 *  O(n + m) rather than the quadratic "for each cut, rebuild the list". */
export const subtractIntervals = (base: Interval[], cuts: Interval[]): Interval[] => {
  const open = mergeIntervals(base)
  const closed = mergeIntervals(cuts)
  if (closed.length === 0) return open

  const out: Interval[] = []
  let c = 0
  for (const window of open) {
    let cursor = window.start.getTime()
    const end = window.end.getTime()
    // Cuts entirely before this window are of no further use to any later window
    // either, because both lists are sorted.
    while (c < closed.length && (closed[c] as Interval).end.getTime() <= cursor) c++

    for (let k = c; k < closed.length; k++) {
      const cut = closed[k] as Interval
      const cutStart = cut.start.getTime()
      if (cutStart >= end) break
      if (cutStart > cursor) out.push({ start: new Date(cursor), end: new Date(cutStart) })
      cursor = Math.max(cursor, cut.end.getTime())
      if (cursor >= end) break
    }
    if (cursor < end) out.push({ start: new Date(cursor), end: new Date(end) })
  }
  return out
}

const containedBy = (windows: Interval[], start: number, end: number): boolean => {
  // Windows are sorted and disjoint, so a binary search would work; at a few
  // windows per day a scan is faster and reads plainly.
  for (const window of windows) {
    if (window.start.getTime() > start) return false
    if (window.end.getTime() >= end) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export type SlotInput = {
  /** The window the caller wants slots for, usually a month in view. */
  from: Date
  to: Date
  now: Date
  /** The host's zone. Windows and the offered grid are both resolved in it. */
  timezone: string
  weekly: WeeklyRules
  overrides: Map<string, DayOverride>
  /** Everything the host is already committed to, from every calendar. */
  busy: Interval[]
  durationMinutes: number
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minNoticeMinutes: number
  maxHorizonDays: number
  granularityMinutes: number
}

/** The whole of §2 in one function.
 *
 *  weekly windows ∩ requested range, minus overrides, minus busy time widened by
 *  the buffers, minus anything inside the notice period or past the horizon.
 *
 *  The offered grid is built in the host's timezone from midnight, not from the
 *  UTC hour, so a host at a 45-minute offset is offered :00 and :30 in their own
 *  day rather than :15 and :45. §Edge cases, Kathmandu.
 *
 *  Cost is O(D·G + B log B): days in range times starts per day, plus the sort of
 *  the busy list. Nothing here scans the busy list per candidate. */
export const computeSlots = (input: SlotInput): Date[] => {
  const duration = Math.max(1, Math.trunc(input.durationMinutes))
  const granularity = Math.max(1, Math.trunc(input.granularityMinutes))
  if (!isKnownTimezone(input.timezone)) return []

  const earliest = Math.max(
    input.from.getTime(),
    input.now.getTime() + input.minNoticeMinutes * MINUTE,
  )
  const horizonEnd = input.now.getTime() + input.maxHorizonDays * DAY
  const latest = Math.min(input.to.getTime(), horizonEnd)
  if (earliest >= latest) return []

  /** A new slot needs `bufferBefore` clear ahead of it and `bufferAfter` clear
   *  behind it, so an existing commitment [s, e] rules out any slot overlapping
   *  [s − bufferAfter, e + bufferBefore]. Widening the commitment once is the same
   *  test as narrowing every candidate, for a fraction of the work. */
  const blocked = mergeIntervals(
    input.busy.map((b) => ({
      start: new Date(b.start.getTime() - input.bufferAfterMinutes * MINUTE),
      end: new Date(b.end.getTime() + input.bufferBeforeMinutes * MINUTE),
    })),
  )

  // A day either side of the requested range: a window that opens on the 1st in
  // Jakarta may start before the 1st in UTC, and vice versa.
  const firstDay = addDays(dayKey(new Date(earliest), input.timezone), -1)
  const lastDay = addDays(dayKey(new Date(latest), input.timezone), 1)

  const slots: Date[] = []
  const seen = new Set<number>()

  for (let key = firstDay; key <= lastDay; key = addDays(key, 1)) {
    const ranges = windowsFor(key, input.weekly, input.overrides)
    if (ranges.length === 0) continue

    const open: Interval[] = []
    let earliestMinute = 1440
    let latestMinute = 0
    for (const range of ranges) {
      const interval = rangeToInterval(key, range, input.timezone)
      if (!interval) continue
      open.push(interval)
      const from = minutesOfDay(range[0]) ?? 0
      const to = minutesOfDay(range[1]) ?? 1440
      earliestMinute = Math.min(earliestMinute, from)
      // A window past midnight ends on the next day, whose own pass covers the
      // grid there. This day only has to reach its own end.
      latestMinute = Math.max(latestMinute, to > from ? to : 1440)
    }
    if (open.length === 0) continue

    const free = subtractIntervals(open, blocked)
    if (free.length === 0) continue

    // Only the minutes this day actually offers, on the grid measured from the
    // host's own midnight. A 9-to-5 day costs sixteen candidates, not forty-eight.
    const firstMinute = Math.floor(earliestMinute / granularity) * granularity
    for (let minute = firstMinute; minute < latestMinute; minute += granularity) {
      const start = zonedTimeToUtc(key, minute, input.timezone).getTime()
      if (start < earliest || start >= latest) continue
      if (seen.has(start)) continue
      if (!containedBy(free, start, start + duration * MINUTE)) continue
      seen.add(start)
      slots.push(new Date(start))
    }
  }
  return slots.sort((a, b) => a.getTime() - b.getTime())
}

/** Which wall-clock windows a given date offers. An override replaces the weekly
 *  rule for that date outright rather than intersecting with it: "I work 9 to 5,
 *  except Friday I am only free 2 to 4" is what a person means by an override. */
const windowsFor = (
  key: string,
  weekly: WeeklyRules,
  overrides: Map<string, DayOverride>,
): TimeRange[] => {
  const override = overrides.get(key)
  if (override) return override.isUnavailable ? [] : override.blocks
  return weekly[String(isoWeekday(key))] ?? []
}

/** A wall-clock range on a date, as an instant range. An end at or before the
 *  start means the window runs past midnight, which is how a late shift is
 *  written: ["22:00", "02:00"]. */
const rangeToInterval = (key: string, range: TimeRange, timeZone: string): Interval | null => {
  const [rawStart, rawEnd] = range
  if (typeof rawStart !== 'string' || typeof rawEnd !== 'string') return null
  const startMinute = minutesOfDay(rawStart)
  const endMinute = minutesOfDay(rawEnd)
  if (startMinute === null || endMinute === null) return null

  const start = zonedTimeToUtc(key, startMinute, timeZone)
  const end =
    endMinute > startMinute
      ? zonedTimeToUtc(key, endMinute, timeZone)
      : zonedTimeToUtc(addDays(key, 1), endMinute, timeZone)

  return end.getTime() > start.getTime() ? { start, end } : null
}

/** Parses whatever is in the JSONB column into rules this module can use, dropping
 *  anything unreadable. A hand-edited schedule with one bad window loses that
 *  window, not the whole day. */
export const readWeekly = (value: unknown): WeeklyRules => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: WeeklyRules = {}
  for (const [key, ranges] of Object.entries(value as Record<string, unknown>)) {
    const weekday = Number(key)
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) continue
    out[String(weekday)] = readRanges(ranges)
  }
  return out
}

export const readRanges = (value: unknown): TimeRange[] => {
  if (!Array.isArray(value)) return []
  const out: TimeRange[] = []
  for (const entry of value) {
    if (!Array.isArray(entry)) continue
    const [start, end] = entry as unknown[]
    if (typeof start !== 'string' || typeof end !== 'string') continue
    if (minutesOfDay(start) === null || minutesOfDay(end) === null) continue
    out.push([start, end])
  }
  return out
}

/** Nine to five, Monday to Friday. What a new host gets before they have opened
 *  the availability screen, so a page is bookable the day it is created. */
export const DEFAULT_WEEKLY: WeeklyRules = {
  '1': [['09:00', '17:00']],
  '2': [['09:00', '17:00']],
  '3': [['09:00', '17:00']],
  '4': [['09:00', '17:00']],
  '5': [['09:00', '17:00']],
}
