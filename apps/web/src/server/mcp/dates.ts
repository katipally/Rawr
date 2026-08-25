import { addDays, dayKey, isoWeekday } from '@rawr/db'

/** F5 §4. "October 15th" and "next Friday", resolved server side.
 *
 *  Trevor says a date the way a person says one. The rule that makes that safe is
 *  not the parser, it is the echo: every write response states the ISO date it
 *  actually set, so a wrong guess is visible in the same breath rather than
 *  discovered a month later on a forecast.
 *
 *  Resolved against the caller's own timezone, because "today" in Jakarta is a
 *  different date from "today" in Los Angeles and a close date is a calendar day,
 *  not an instant. The reference day is passed in rather than read from the clock,
 *  so every case here is testable at a fixed date. */

export type DateResolution =
  | { ok: true; day: string; how: string }
  | { ok: false; reason: string }

const WEEKDAYS: Record<string, number> = {
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  sunday: 7, sun: 7,
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

/** `2026-10-15`, always. The one format the rest of the system stores and the one
 *  the response quotes back. */
const iso = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate()

/** `today` is the caller's own calendar day, not the server's. */
export const resolveDate = (input: string, today: string): DateResolution => {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!text) return { ok: false, reason: 'That date was empty.' }

  const exact = ISO.exec(text)
  if (exact) {
    const [, y, m, d] = exact
    const year = Number(y)
    const month = Number(m)
    const day = Number(d)
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      return { ok: false, reason: `${text} is not a real date.` }
    }
    return { ok: true, day: iso(year, month, day), how: 'as given' }
  }

  if (text === 'today') return { ok: true, day: today, how: 'today for you' }
  if (text === 'tomorrow') return { ok: true, day: addDays(today, 1), how: 'the day after today for you' }
  if (text === 'yesterday') return { ok: true, day: addDays(today, -1), how: 'the day before today for you' }

  // "in 3 days", "in 2 weeks", "in 1 month"
  const relative = /^in (\d{1,3}) (day|days|week|weeks|month|months)$/.exec(text)
  if (relative) {
    const count = Number(relative[1])
    const unit = relative[2]!
    if (unit.startsWith('day')) return { ok: true, day: addDays(today, count), how: `${count} days from today` }
    if (unit.startsWith('week')) return { ok: true, day: addDays(today, count * 7), how: `${count} weeks from today` }
    return { ok: true, day: addMonths(today, count), how: `${count} months from today` }
  }

  // "next friday", "this friday", "friday". "Next" is the coming one, never the one
  // eight days out: a person saying "next Friday" on a Monday means that Friday.
  const weekday = /^(next |this |on |coming )?([a-z]+)$/.exec(text)
  if (weekday && WEEKDAYS[weekday[2]!]) {
    const target = WEEKDAYS[weekday[2]!]!
    const current = isoWeekday(today)
    const ahead = (target - current + 7) % 7 || 7
    return { ok: true, day: addDays(today, ahead), how: `the next ${weekday[2]} after today` }
  }

  // "october 15th", "15 october", "oct 15 2027". A month without a year means the
  // next occurrence, which is the one case the doc calls out by name, and the echo
  // is what makes a wrong reading obvious.
  const named = monthAndDay(text)
  if (named) {
    const [year] = today.split('-').map(Number)
    if (named.year) {
      if (named.day > daysInMonth(named.year, named.month)) {
        return { ok: false, reason: `${text} is not a real date.` }
      }
      return { ok: true, day: iso(named.year, named.month, named.day), how: 'as given' }
    }
    if (named.day > daysInMonth(year!, named.month)) {
      return { ok: false, reason: `${text} is not a real date in ${year}.` }
    }
    const thisYear = iso(year!, named.month, named.day)
    if (thisYear >= today) return { ok: true, day: thisYear, how: `the next occurrence, in ${year}` }
    const next = year! + 1
    if (named.day > daysInMonth(next, named.month)) {
      return { ok: false, reason: `${text} is not a real date in ${next}.` }
    }
    return { ok: true, day: iso(next, named.month, named.day), how: `the next occurrence, in ${next}` }
  }

  return {
    ok: false,
    reason: `"${input}" could not be read as a date. Use YYYY-MM-DD, or a phrase like "next Friday", "tomorrow", "15 October".`,
  }
}

const ORDINAL = /(\d{1,2})(?:st|nd|rd|th)?/

const monthAndDay = (text: string): { month: number; day: number; year: number | null } | null => {
  const words = text.replace(/,/g, ' ').split(' ').filter(Boolean)
  let month: number | null = null
  let day: number | null = null
  let year: number | null = null

  for (const word of words) {
    const named = MONTHS[word]
    if (named && month === null) {
      month = named
      continue
    }
    if (/^\d{4}$/.test(word)) {
      year = Number(word)
      continue
    }
    const ordinal = ORDINAL.exec(word)
    if (ordinal && day === null && /^\d{1,2}(st|nd|rd|th)?$/.test(word)) {
      day = Number(ordinal[1])
    }
  }

  if (month === null || day === null || day < 1 || day > 31) return null
  return { month, day, year }
}

/** Clamped rather than rolled over: "in 1 month" from the 31st is the end of the
 *  next month, not the 3rd of the one after. */
const addMonths = (day: string, months: number): string => {
  const [y, m, d] = day.split('-').map(Number)
  const total = (m! - 1) + months
  const year = y! + Math.floor(total / 12)
  const month = (total % 12 + 12) % 12 + 1
  return iso(year, month, Math.min(d!, daysInMonth(year, month)))
}

/** The caller's today, in their own zone, which is the reference every phrase above
 *  is measured from. */
export const todayFor = (timezone: string, now = new Date()): string => dayKey(now, timezone)
