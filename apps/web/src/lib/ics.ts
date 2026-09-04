/** One meeting, as the file every calendar application will open.
 *
 *  RFC 5545 is fussy in ways that are easy to get wrong and hard to notice, because
 *  a malformed file usually imports anyway in one client and silently fails in
 *  another. The three rules that actually bite are all handled here: text values
 *  escape comma, semicolon and backslash; lines fold at 75 octets; and every line
 *  ends CRLF, including the last one.
 *
 *  Times are written as UTC instants. A calendar shows them in the reader's own
 *  zone, which is what somebody who books from an airport wants. */

export type IcsEvent = {
  /** Stable for the life of the meeting, so re-importing updates rather than
   *  duplicating, and a reschedule replaces what is already in the calendar. */
  uid: string
  /** Bumped on every change to the same uid. A calendar ignores an update whose
   *  sequence is not higher than the one it holds. */
  sequence?: number
  startsAt: Date
  endsAt: Date
  summary: string
  description?: string | null
  location?: string | null
  organiser?: { name: string; email: string } | null
  attendee?: { name: string; email: string } | null
  cancelled?: boolean
}

const stamp = (date: Date): string => `${date.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`

/** Backslash first, or every escape added after it gets escaped again. */
const escape = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

/** Folded at 75 octets rather than 75 characters: the limit is on bytes, and a
 *  name with an accent in it is two. Splitting mid-character would corrupt it, so
 *  the encoder measures each character before taking it. */
const fold = (line: string): string => {
  const encoder = new TextEncoder()
  const parts: string[] = []
  let current = ''
  let width = 0
  for (const character of line) {
    const size = encoder.encode(character).length
    // 75 on the first line, 74 on the rest: a continuation spends one octet on
    // the leading space.
    if (width + size > (parts.length === 0 ? 75 : 74)) {
      parts.push(current)
      current = ''
      width = 0
    }
    current += character
    width += size
  }
  parts.push(current)
  return parts.join('\r\n ')
}

export const buildIcs = (event: IcsEvent): string => {
  const person = (role: 'ORGANIZER' | 'ATTENDEE', who: { name: string; email: string }): string =>
    `${role};CN=${escape(who.name)}:mailto:${who.email}`

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rawr//Booking//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${event.cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `SEQUENCE:${event.sequence ?? 0}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(event.startsAt)}`,
    `DTEND:${stamp(event.endsAt)}`,
    `SUMMARY:${escape(event.summary)}`,
    event.description ? `DESCRIPTION:${escape(event.description)}` : null,
    event.location ? `LOCATION:${escape(event.location)}` : null,
    event.organiser ? person('ORGANIZER', event.organiser) : null,
    event.attendee ? person('ATTENDEE', event.attendee) : null,
    `STATUS:${event.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter((line): line is string => line !== null)

  return `${lines.map(fold).join('\r\n')}\r\n`
}
