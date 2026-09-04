/** Every sentence a stranger reads while a form or a booking is in flight.
 *
 *  One module because the same moment happens in four places: the inline embed,
 *  the hosted no-JavaScript page, the booking widget and the booking page. When
 *  those drift, the same failure is described two different ways depending on
 *  which one somebody happened to open, and nobody notices because each reads
 *  fine on its own.
 *
 *  Written for the visitor, not for us: no status codes, no "an error occurred",
 *  and every failure says what to do next.
 *
 *  The tables hold strings only, so they survive `JSON.stringify` into the two
 *  embed scripts. The handful of sentences that need a number are standalone
 *  functions below, inlined into those scripts by source for the same reason: one
 *  implementation, tested here, running there. */

export const FORM_COPY = {
  /** While the request is in flight. Replaces the button's own label. */
  sending: 'Sending…',
  sent: 'Thanks, that is with us.',
  /** The server refused specific fields. The fields say which; this says where. */
  invalid: 'Check the highlighted answers.',
  /** The request itself failed, rather than the answers. */
  failed: 'That could not be sent. Nothing was lost, so try again.',
  offline: 'You appear to be offline. Your answers are still here; send again once you are back.',
  retry: 'Try again',
  challenge: 'One quick check before we can send this.',
  required: 'This is required.',
} as const

export const BOOKING_COPY = {
  loading: 'Finding open times…',
  jumpToNext: 'Jump to it',
  nothingAtAll: 'Nothing is open at the moment. Try again in a day or two.',
  nothingOnDay: 'Nothing open on this day. Pick another.',
  pickDay: 'Pick a day to see the times that are open.',
  booking: 'Booking…',
  booked: 'You are booked.',
  /** Somebody took the slot while this person was filling the form in. */
  slotGone: 'Somebody took that time while you were typing. Here are the times still open.',
  failed: 'That could not be booked. Nothing was lost, so try again.',
  offline: 'You appear to be offline. Your answers are still here; book again once you are back.',
  holdExpired: 'The hold on that time has run out. It may still be free; choose it again to check.',
  addToCalendar: 'Add to your calendar',
  reschedule: 'Move this meeting',
  cancel: 'Cancel it',
  /** The manage page, where both actions call a calendar provider and the wait is
   *  long enough that a second click is the natural thing to do. */
  moving: 'Moving…',
  cancelling: 'Cancelling…',
} as const

// ---------------------------------------------------------------- formatters
//
// Standalone, self-contained and written in the embed's conservative style: each
// is inlined into a browser script by `.toString()`, so it may not close over
// anything or use syntax the surrounding file happens to allow.

/** mm:ss, for a countdown a person is watching. Never "0:60", and never negative:
 *  a hold that has run out reads as expired rather than as minus one second. */
export function countdown(msRemaining: number): string {
  var total = Math.max(0, Math.round(msRemaining / 1000))
  var minutes = Math.floor(total / 60)
  var seconds = total % 60
  return minutes + ':' + String(seconds).padStart(2, '0')
}

/** Shown under a success message that is about to navigate somewhere. */
export function formRedirecting(seconds: number): string {
  return seconds <= 1 ? 'Taking you there now…' : 'Taking you there in ' + seconds + ' seconds…'
}

export function formStep(current: number, total: number): string {
  return 'Step ' + current + ' of ' + total
}

/** No times this month, but there are some later. */
export function bookingNextAvailable(when: string): string {
  return 'Nothing open this month. The next free time is ' + when + '.'
}

/** The courtesy hold, counting down. */
export function bookingHeld(remaining: string): string {
  return 'This time is held for you for ' + remaining + '.'
}

/** Where a meeting happens, in the visitor's words rather than the enum's. Shared
 *  so the hosted page and the embed name the same thing the same way. */
export const BOOKING_LOCATIONS: Record<string, string> = {
  zoom: 'Zoom',
  google_meet: 'Google Meet',
  phone: 'Phone call',
  custom: 'See the invitation',
}

/** Which part of the day a time belongs to. A day of half-hour slots is forty
 *  buttons in one column; three named runs is a list somebody can scan. */
export function slotBandOf(hour: number): string {
  if (hour < 12) return 'Morning'
  if (hour < 17) return 'Afternoon'
  return 'Evening'
}

/** The hour a slot falls on where the visitor is, which is the only hour that
 *  decides which run it belongs to. */
export function hourIn(date: Date, tz: string): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(date),
  )
}

/** Who the visitor is about to meet. Two names read better than a list of five,
 *  and a round robin is a team rather than a person, so past three it counts. */
export function bookingHosts(names: string[]): string {
  if (!names || names.length === 0) return ''
  if (names.length === 1) return 'With ' + names[0]
  if (names.length === 2) return 'With ' + names[0] + ' and ' + names[1]
  if (names.length === 3) return 'With ' + names[0] + ', ' + names[1] + ' and ' + names[2]
  return 'With ' + names[0] + ' and ' + (names.length - 1) + ' others'
}

/** Which weekday a calendar starts on, and the short headings above it, for one
 *  locale. Monday across most of Europe, Sunday in the US, Saturday across much
 *  of the Middle East.
 *
 *  Written in the same plain style as the formatters because it is inlined into
 *  the embed script, where the visitor's own navigator.language is the only
 *  answer available. */
export function weekInfoFor(tag: string): { firstDay: number; weekdays: string[] } {
  // getWeekInfo is ES2024 and present in every runtime this ships to, but not yet
  // in TypeScript's Intl lib, so the shape is declared where it is read.
  var locale: Intl.Locale & { getWeekInfo?: () => { firstDay: number } }
  var used = tag
  try {
    locale = new Intl.Locale(used)
  } catch {
    used = 'en-US'
    locale = new Intl.Locale(used)
  }
  // Where getWeekInfo is missing, Monday is the commoner answer.
  var week = locale.getWeekInfo ? locale.getWeekInfo() : null
  var firstDay = week && week.firstDay ? week.firstDay : 1
  var naming = new Intl.DateTimeFormat(used, { weekday: 'short', timeZone: 'UTC' })
  var weekdays = []
  // 2024-01-01 was a Monday, so ISO weekday n is that date plus (n - 1) days.
  for (var offset = 0; offset < 7; offset++) {
    weekdays.push(naming.format(new Date(Date.UTC(2024, 0, 1 + ((firstDay - 1 + offset) % 7)))))
  }
  return { firstDay: firstDay, weekdays: weekdays }
}

/** The formatter sources, for inlining into the two embed scripts. Taken from the
 *  functions rather than repeated, so the browser runs what the tests ran. */
export const formatterSource = (): string =>
  [
    countdown,
    formRedirecting,
    formStep,
    bookingNextAvailable,
    bookingHeld,
    bookingHosts,
    slotBandOf,
    hourIn,
    weekInfoFor,
  ]
    .map((formatter) => formatter.toString())
    .join('\n  ')
