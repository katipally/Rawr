/** Clock times for the time field: the 'HH:MM' values it holds, the list it
 *  suggests, and the reading of what somebody typed. Pure so the edge cases (a
 *  24:00 end of day, a 12:30 am, a typed 930) are testable without a browser. */

/** Values are 24-hour 'HH:MM' strings, the shape the schedule and sequence rows
 *  already store. */
const CLOCK = /^(\d{2}):(\d{2})$/
const TYPED = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/

const pad = (value: number): string => String(value).padStart(2, '0')

const clock = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`

/** Minutes after midnight for a stored 'HH:MM', or null for anything else, 24:00
 *  included, so a value outside the clock is shown as it was stored. */
export const minutesOf = (value: string): number | null => {
  const match = CLOCK.exec(value)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null
}

/** Every step of the day as 'HH:MM', in order. A 15-minute step is 96 entries. */
export const suggestedTimes = (stepMinutes: number): string[] =>
  Array.from({ length: Math.floor(1440 / stepMinutes) }, (_, index) => clock(index * stepMinutes))

/** How a stored time reads to this locale: "9:30 AM" in the US, "09:30" in most of
 *  Europe. A value that is not a clock time is returned as it was stored. */
const formatters = new Map<string, Intl.DateTimeFormat>()

export const clockLabel = (value: string, locale: string): string => {
  const minutes = minutesOf(value)
  if (minutes === null) return value
  let format = formatters.get(locale)
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    formatters.set(locale, format)
  }
  return format.format(Date.UTC(2000, 0, 1, Math.floor(minutes / 60), minutes % 60))
}

/** What somebody typed as a stored 'HH:MM', or null when it is not a time. Accepts
 *  "9:30", "930", "9", "9:30 pm", "9.30p" and "14:30". Twelve-hour input needs its
 *  1 to 12 hour, and twenty-four-hour input its 0 to 23. */
export const parseClock = (typed: string): string | null => {
  const match = TYPED.exec(typed.toLowerCase().replaceAll(/[\s.]/g, ''))
  if (!match) return null
  let hours = Number(match[1])
  const minutes = Number(match[2] ?? 0)
  const half = match[3]
  if (minutes > 59) return null
  if (half) {
    if (hours < 1 || hours > 12) return null
    hours = (hours % 12) + (half.startsWith('p') ? 12 : 0)
  } else if (hours > 23) {
    return null
  }
  return clock(hours * 60 + minutes)
}
