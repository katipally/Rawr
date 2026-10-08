const DAY_MS = 86_400_000

/** What follows "This meeting is cancelled". A reason the host or visitor already
 *  ended with . ! or ? is kept as written, so it is never given a second stop. */
export const cancelledWhy = (reason: string | null | undefined): string => {
  const text = reason?.trim()
  if (!text) return '.'
  return `: ${/[.!?]$/.test(text) ? text : `${text}.`}`
}

/** The open times a reschedule offers: from now to the page's own horizon. */
export const rescheduleWindow = (now: Date, maxHorizonDays: number) => ({
  now,
  from: now,
  to: new Date(now.getTime() + maxHorizonDays * DAY_MS),
})
