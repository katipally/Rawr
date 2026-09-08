/** Calendar arithmetic for the booking widget, in the visitor's own timezone.
 *
 *  Every date here is a `YYYY-MM-DD` string in a named zone rather than a Date,
 *  because the only date that matters is the one the visitor is clicking on. A
 *  23:30 slot in Los Angeles is the next day in Jakarta, and the person in Jakarta
 *  is right.
 *
 *  Nothing in this file touches the database or the DOM, so it runs in the browser
 *  and in a test with equal indifference. */

/** The visitor's calendar date for an instant, in a named zone. */
export const dayKeyIn = (at: Date, timezone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)

export const monthKeyOf = (day: string): string => day.slice(0, 7)

export const shiftMonth = (monthKey: string, by: number): string => {
  const [year = 1970, month = 1] = monthKey.split('-').map(Number)
  const at = new Date(Date.UTC(year, month - 1 + by, 1))
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Sunday is 0, matching Date.getUTCDay, because that is what the grid indexes on. */
const weekdayOf = (day: string): number => new Date(`${day}T12:00:00Z`).getUTCDay()

export const addDays = (day: string, by: number): string => {
  const at = new Date(`${day}T12:00:00Z`)
  at.setUTCDate(at.getUTCDate() + by)
  return at.toISOString().slice(0, 10)
}

/** A whole month, padded to start on whichever weekday the visitor's locale begins
 *  its week on, so the grid lines up under the weekday headings. Monday in most of
 *  Europe, Sunday in the US, Saturday across much of the Middle East. */
export const monthCells = (monthKey: string, firstDay: number): (string | null)[] => {
  const first = `${monthKey}-01`
  const pad = (weekdayOf(first) - firstDay + 7) % 7
  const cells: (string | null)[] = Array.from({ length: pad }, () => null)
  for (let day = first; day.startsWith(monthKey); day = addDays(day, 1)) cells.push(day)
  return cells
}

/** Which weekday a calendar starts on, and the short headings above it.
 *
 *  Sunday is 0 here rather than the ISO 1–7 getWeekInfo answers with, because the
 *  grid and `Date.getUTCDay` both count from Sunday and one convention across the
 *  file is worth the conversion. */
export const weekInfo = (locale: string): { firstDay: number; weekdays: string[] } => {
  // getWeekInfo is ES2024 and present in every browser this ships to, but not yet
  // in TypeScript's Intl lib, so the shape is declared where it is read.
  let resolved: Intl.Locale & { getWeekInfo?: () => { firstDay: number } }
  let tag = locale
  try {
    resolved = new Intl.Locale(tag)
  } catch {
    tag = 'en-US'
    resolved = new Intl.Locale(tag)
  }
  const iso = resolved.getWeekInfo?.().firstDay ?? 1
  const firstDay = iso % 7
  const naming = new Intl.DateTimeFormat(tag, { weekday: 'short', timeZone: 'UTC' })
  const weekdays: string[] = []
  // 2024-01-07 was a Sunday, so weekday n is that date plus n days.
  for (let offset = 0; offset < 7; offset++) {
    weekdays.push(naming.format(new Date(Date.UTC(2024, 0, 7 + ((firstDay + offset) % 7)))))
  }
  return { firstDay, weekdays }
}

export const formatTime = (
  at: Date,
  timezone: string,
  locale: string,
  hour12: boolean,
): string =>
  new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  }).format(at)

export const formatDayLong = (day: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${day}T12:00:00Z`))

export const formatDayShort = (day: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${day}T12:00:00Z`))

export const formatMonth = (monthKey: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(
    new Date(`${monthKey}-01T12:00:00Z`),
  )

/** "GMT+1", as the browser names it. Shown beside the zone because a zone name
 *  alone does not tell somebody in a hurry whether they are five hours out. */
export const offsetLabel = (timezone: string, at: Date): string => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  }).formatToParts(at)
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
}

/** Every zone the browser knows, for the picker. Older engines without
 *  supportedValuesOf get the zone they are already in, which is the one that
 *  matters; the list is a convenience, not the mechanism. */
export const knownTimezones = (fallback: string): string[] => {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  const all = supported ? supported('timeZone') : []
  return all.length > 0 ? all : [fallback, 'UTC']
}

export const detectTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
