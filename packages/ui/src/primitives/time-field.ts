/** Clock times for the time field: the 'HH:MM' values it holds, the list it
 *  suggests, and the reading of what somebody typed. Pure so the edge cases (a
 *  24:00 end of day, a 12:30 am, a typed 930) are testable without a browser. */

/** Values are 24-hour 'HH:MM' strings, the shape the schedule and sequence rows
 *  already store. */
const CLOCK = /^(\d{1,2}):(\d{2})$/
const TYPED = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/

const pad = (value: number): string => String(value).padStart(2, '0')

const clock = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`

/** Minutes after midnight for a stored 'HH:MM', or null for anything else. 24:00 is
 *  1440, the end of the day, which the Date formatter reads as midnight. */
export const minutesOf = (value: string): number | null => {
  const match = CLOCK.exec(value)
  if (!match) return null
  const total = Number(match[1]) * 60 + Number(match[2])
  return Number(match[2]) < 60 && total <= 1440 ? total : null
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

/** A row the list can pick: its stored 'HH:MM' and how it reads in the viewer's locale. */
export type TimeRow = { value: string; label: string }

/** Spaces and case dropped, so "9:30 am" and "9:30AM" are the same search. */
const squash = (text: string): string => text.toLowerCase().replaceAll(/\s+/g, '')

/** The rows the typed text leaves in the list. Nothing typed keeps every row. */
export const narrow = (rows: TimeRow[], typed: string | null): TimeRow[] => {
  if (!typed) return rows
  const query = squash(typed)
  return rows.filter((row) => squash(row.label).includes(query) || row.value.includes(query))
}

export type TimeFieldState = {
  /** What is typed, or null while the field shows the stored time. */
  typed: string | null
  open: boolean
  /** The row the arrow keys are on, or -1. */
  highlight: number
  /** The row under the pointer, or -1. It lights a row and nothing else. */
  hover: number
  /** Whether an arrow key moved the highlight since the list opened or the text last changed. */
  touched: boolean
}

export const closedField: TimeFieldState = { typed: null, open: false, highlight: -1, hover: -1, touched: false }

export type TimeFieldEvent =
  | { type: 'open' }
  | { type: 'text'; text: string }
  | { type: 'arrow'; step: 1 | -1 }
  | { type: 'hoverEnter'; index: number }
  | { type: 'hoverLeave' }
  | { type: 'pick'; value: string }
  | { type: 'settle' }
  | { type: 'escape' }
  | { type: 'dismiss' }

export type TimeFieldStep = { state: TimeFieldState; emit: string | null }

/** What leaving the field keeps. Only an arrow-moved row beats the typed text, and
 *  text that is not a time falls back to the stored value. */
const settledValue = (state: TimeFieldState, shown: TimeRow[], value: string): string => {
  const row = shown[state.highlight]
  if (state.touched && row) return row.value
  if (state.typed === null) return value
  if (state.typed.trim() === '') return ''
  return parseClock(state.typed) ?? value
}

/** The whole field as one transition. Only pick and settle can change the stored
 *  time; typing and the arrow keys move the list, and hover moves nothing but its
 *  own row light, so a row the pointer rests on can never become the value. */
export const stepTimeField = (
  state: TimeFieldState,
  event: TimeFieldEvent,
  value: string,
  rows: TimeRow[],
): TimeFieldStep => {
  const shown = narrow(rows, state.typed)
  const valueAt = shown.findIndex((row) => row.value === value)
  const rest = (next: TimeFieldState): TimeFieldStep => ({ state: next, emit: null })
  switch (event.type) {
    case 'open':
      return rest({ ...state, open: true, highlight: valueAt })
    case 'text':
      return rest({ typed: event.text, open: true, highlight: 0, hover: -1, touched: false })
    case 'arrow': {
      if (!state.open) return rest({ ...state, open: true, highlight: valueAt, hover: -1, touched: true })
      const count = shown.length
      const from = state.highlight < 0 ? (event.step > 0 ? -1 : count) : state.highlight
      const highlight = count === 0 ? -1 : (from + event.step + count) % count
      return rest({ ...state, highlight, hover: -1, touched: true })
    }
    case 'hoverEnter':
      return rest({ ...state, hover: event.index })
    case 'hoverLeave':
      return rest({ ...state, hover: -1 })
    case 'pick':
      return { state: closedField, emit: event.value === value ? null : event.value }
    case 'settle': {
      const next = settledValue(state, shown, value)
      return { state: closedField, emit: next === value ? null : next }
    }
    case 'escape':
      return rest(closedField)
    case 'dismiss':
      return rest({ ...state, open: false, hover: -1, touched: false })
  }
}
