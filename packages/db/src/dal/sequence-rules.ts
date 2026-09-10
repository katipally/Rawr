/** When a step may go out, and what the mail says. Pure functions, so the parts
 *  that are easy to get quietly wrong (a window that spans a weekend, a cap that
 *  resets in the sender's timezone rather than UTC, a merge field with no value)
 *  are testable without a database or a clock. */

export type SendWindow = {
  /** ISO weekdays: 1 is Monday, 7 is Sunday. */
  days: number[]
  /** Local wall-clock times in `timezone`, "HH:MM". */
  start: string
  end: string
  timezone: string
}

export const DEFAULT_WINDOW: SendWindow = {
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '17:00',
  timezone: 'UTC',
}

const minutesOf = (value: string): number => {
  const [hours = '0', minutes = '0'] = value.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/** The wall clock in a named zone, as parts. Uses Intl rather than arithmetic on
 *  an offset, because an offset is not a constant: the whole point of asking is
 *  that it changes twice a year. */
const partsIn = (at: Date, timezone: string): { isoDay: number; minutes: number } => {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]))
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const isoDay = days.indexOf(parts.weekday ?? 'Mon') + 1
  // 24:00 is how some locales render midnight; it means the start of that day.
  const hour = Number(parts.hour ?? '0') % 24
  return { isoDay: isoDay === 0 ? 1 : isoDay, minutes: hour * 60 + Number(parts.minute ?? '0') }
}

export const inWindow = (at: Date, window: SendWindow): boolean => {
  const { isoDay, minutes } = partsIn(at, window.timezone)
  if (!window.days.includes(isoDay)) return false
  return minutes >= minutesOf(window.start) && minutes < minutesOf(window.end)
}

/** The next instant at or after `from` that falls inside the window.
 *
 *  Walks in ten-minute steps rather than computing an offset, because computing
 *  one means knowing the zone's rules on the day, and the day may be the one the
 *  clocks change. At most eight days of steps, so O(1) with a small constant, and
 *  it returns `from` unchanged when the window is already open. */
export const nextOpening = (from: Date, window: SendWindow): Date => {
  if (window.days.length === 0) return from
  if (inWindow(from, window)) return from

  const STEP_MINUTES = 10
  const LIMIT = (8 * 24 * 60) / STEP_MINUTES
  let at = new Date(Math.ceil(from.getTime() / (STEP_MINUTES * 60_000)) * STEP_MINUTES * 60_000)
  for (let index = 0; index < LIMIT; index += 1) {
    if (inWindow(at, window)) return at
    at = new Date(at.getTime() + STEP_MINUTES * 60_000)
  }
  // A window that never opens, which the editor refuses to save. Rather than loop
  // for ever, say so by handing back the original instant.
  return from
}

/** When the next step may run: the delay, then the window, then the minimum gap
 *  since this mailbox last sent anything. */
export const nextSendAt = (input: {
  after: Date
  delayDays: number
  delayHours: number
  window: SendWindow
  lastSentAt?: Date | null
  minGapSeconds?: number
}): Date => {
  const delayed = new Date(
    input.after.getTime() + input.delayDays * 86_400_000 + input.delayHours * 3_600_000,
  )
  const gapped =
    input.lastSentAt && input.minGapSeconds
      ? new Date(Math.max(delayed.getTime(), input.lastSentAt.getTime() + input.minGapSeconds * 1000))
      : delayed
  return nextOpening(gapped, input.window)
}

export const capReached = (sentToday: number, cap: number): boolean => sentToday >= cap

/** `{{first_name}}`, or `{{first_name|there}}` when it might be blank.
 *
 *  A merge field with no value and no fallback is the classic "Hi ," mail, so an
 *  unresolved field without a fallback makes the whole render fail rather than
 *  send something embarrassing. */
export type RenderResult = { text: string; missing: string[] }

export const renderMergeFields = (template: string, values: Record<string, string | null | undefined>): RenderResult => {
  const missing: string[] = []
  const text = template.replace(/\{\{\s*([a-z0-9_.]+)\s*(?:\|([^}]*))?\}\}/gi, (_whole, rawKey: string, fallback?: string) => {
    const key = rawKey.trim()
    const value = values[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value)
    if (fallback !== undefined) return fallback.trim()
    missing.push(key)
    return ''
  })
  return { text, missing }
}

/** Which merge fields a template uses, for the editor's preview and for refusing
 *  to activate a sequence whose fields nobody can fill. */
export const mergeFields = (template: string): string[] => [
  ...new Set(
    [...template.matchAll(/\{\{\s*([a-z0-9_.]+)\s*(?:\|[^}]*)?\}\}/gi)].map((match) => (match[1] ?? '').trim()),
  ),
]

/** The only keys the send has values for, and therefore the only ones a template
 *  may use. Deliberately short: a template that could read any field would be a
 *  way to put anything in the CRM into a stranger's inbox. The pickers in the
 *  editors offer this list and the save refuses anything outside it, so a typo is
 *  caught where it is made rather than in somebody's inbox. */
export const MERGE_FIELD_KEYS = [
  'first_name',
  'last_name',
  'full_name',
  'company',
  'email',
  'sender_email',
  'sequence',
] as const

export type MergeFieldKey = (typeof MERGE_FIELD_KEYS)[number]

export const unknownMergeFields = (template: string): string[] =>
  mergeFields(template).filter((key) => !(MERGE_FIELD_KEYS as readonly string[]).includes(key))
