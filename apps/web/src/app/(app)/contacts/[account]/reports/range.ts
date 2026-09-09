import { clampRange, type Range, readSchedule } from '@rawr/db'
import { contextFrom, type Session } from '~/server/session.ts'

/** The range every report page reads out of its own URL. One place, so a link
 *  pasted between two reports means the same thing in both.
 *
 *  Every boundary is a calendar day in the reader's own timezone, never UTC. A
 *  day is not an instant: for anyone west of Greenwich, UTC midnight falls in
 *  the previous afternoon, so a UTC range put the last few hours of each day in
 *  the wrong bucket and, after 5pm Pacific, named tomorrow as the end of "last
 *  30 days". Charts already learned this (see `formatDayShort`); the range that
 *  feeds them had not. */

export type RangeParams = { from?: string | undefined; to?: string | undefined }

const DAY_MS = 24 * 60 * 60 * 1000

/** How far ahead of UTC the zone is at this instant, in milliseconds. */
const offsetAt = (at: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  // Some ICU builds render midnight as hour 24 under hour12: false.
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return wall - at.getTime()
}

/** The instant midnight begins on `day` in `timeZone`. Applied twice because the
 *  offset is itself read at an instant, and the two differ across a DST change. */
const dayStart = (day: string, timeZone: string): Date => {
  const target = Date.parse(`${day}T00:00:00Z`)
  const once = target - offsetAt(new Date(target), timeZone)
  return new Date(target - offsetAt(new Date(once), timeZone))
}

/** The calendar day an instant falls on, in `timeZone`. en-CA is YYYY-MM-DD. */
const dayOf = (at: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)

export const rangeFrom = (
  params: RangeParams,
  timeZone: string,
): Range & { fromDay: string; toDay: string } => {
  // A date with no time means the whole of that day, so the end is exclusive at
  // midnight the following morning rather than excluding the day it names.
  const lastDay = params.to ?? dayOf(new Date(), timeZone)
  const range = clampRange({
    from: params.from ? dayStart(params.from, timeZone) : null,
    to: new Date(dayStart(lastDay, timeZone).getTime() + DAY_MS),
  })
  return {
    ...range,
    fromDay: dayOf(range.from, timeZone),
    toDay: dayOf(new Date(range.to.getTime() - 1), timeZone),
  }
}

/** The reader's timezone is the one they set under Settings, Your account, which
 *  is the same one their working hours and their meetings are shown in. */
export const reportRange = async (
  session: Session,
  params: RangeParams,
): Promise<Range & { fromDay: string; toDay: string }> => {
  const schedule = await readSchedule(contextFrom(session), session.userId)
  return rangeFrom(params, schedule.timezone)
}
