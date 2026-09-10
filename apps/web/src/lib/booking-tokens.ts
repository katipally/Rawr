/** What a booking page's mail may say, and what it says when nobody has changed
 *  it. Here rather than beside the sender because the editor shows the same list
 *  and the same defaults, and two copies would drift.
 *
 *  The token spelling is HubSpot's, so wording lifted from a HubSpot template
 *  resolves rather than rendering as nothing. */

import type { ReminderUnit } from '@rawr/db'

/** Copied from @rawr/db rather than imported: importing a value from there into a
 *  client component pulls the Postgres driver into the browser bundle. The
 *  annotation is what makes a unit renamed there fail to compile here. */
export const REMINDER_UNITS: readonly ReminderUnit[] = ['week', 'day', 'hour', 'minute']

export const BOOKING_MAIL_TOKENS = [
  'contact.firstname',
  'contact.lastname',
  'contact.email',
  'company.name',
  'host.firstname',
  'host.lastname',
  'host.signature',
  'meeting.date',
  'meeting.time',
  'meeting.location',
  'meeting.description',
] as const

export const DEFAULT_CONFIRMATION_SUBJECT = 'Your meeting with {{ host.firstname }} is booked'

export const DEFAULT_CONFIRMATION_BODY = [
  'Hello {{ contact.firstname }},',
  '',
  'Your meeting is booked for:',
  '',
  '{{ meeting.date }} at {{ meeting.time }}',
  '{{ meeting.location }}',
  '',
  'Looking forward to it,',
  '{{ host.signature }}',
].join('\n')

export const DEFAULT_REMINDER_SUBJECT = 'Reminder: {{ meeting.date }} at {{ meeting.time }}'

/** HubSpot's own default reminder wording, in Rawr's token syntax. */
export const DEFAULT_REMINDER_BODY = [
  'Hello {{ contact.firstname }},',
  '',
  'This is a friendly reminder that we have a meeting booked on:',
  '',
  '{{ meeting.date }} {{ meeting.time }}',
  '{{ meeting.location }}',
  '',
  'I look forward to meeting with you,',
  '{{ host.signature }}',
].join('\n')
