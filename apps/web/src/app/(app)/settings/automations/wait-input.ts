/** A wait is typed as a whole amount and a unit, and stored as minutes. The
 *  editor holds the amount exactly as typed, so a half-typed value stays visible. */
const UNITS = {
  minutes: { one: 'minute', size: 1 },
  hours: { one: 'hour', size: 60 },
  days: { one: 'day', size: 24 * 60 },
} as const

export type DelayUnit = keyof typeof UNITS

export const DELAY_UNITS = Object.keys(UNITS) as DelayUnit[]

export const delayText = (amount: string, unit: DelayUnit): string =>
  `${amount} ${UNITS[unit].one}${amount === '1' ? '' : 's'}`

/** The largest unit that divides the stored minutes evenly, so 2880 reads as 2 days. */
export const delayFrom = (minutes: number): { amount: string; unit: DelayUnit } => {
  if (minutes % UNITS.days.size === 0) return { amount: String(minutes / UNITS.days.size), unit: 'days' }
  if (minutes % UNITS.hours.size === 0) return { amount: String(minutes / UNITS.hours.size), unit: 'hours' }
  return { amount: String(minutes), unit: 'minutes' }
}

export const describeWait = (minutes: number): string => {
  const { amount, unit } = delayFrom(minutes)
  return delayText(amount, unit)
}

/** Minutes for a typed amount. Not a whole number of digits gives NaN, which
 *  `waitFits` refuses. */
export const waitMinutes = (amount: string, unit: DelayUnit): number =>
  /^\d+$/.test(amount) ? Number(amount) * UNITS[unit].size : Number.NaN

export const waitFits = (minutes: number, maxMinutes: number): boolean =>
  Number.isInteger(minutes) && minutes >= 1 && minutes <= maxMinutes
