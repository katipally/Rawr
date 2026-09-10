import {
  listMailboxes,
  notify,
  renderTemplate,
  systemContext,
  withAccount,
  type AccountContext,
  type BookingPageConfig,
  type TemplateValues,
} from '@rawr/db'
import {
  DEFAULT_CONFIRMATION_BODY,
  DEFAULT_CONFIRMATION_SUBJECT,
  DEFAULT_REMINDER_BODY,
  DEFAULT_REMINDER_SUBJECT,
} from '~/lib/booking-tokens.ts'
import { publicBaseUrl } from '~/lib/env.ts'
import { bookingManagePath } from '~/lib/links.ts'
import { compose } from './sequences/compose.ts'

/** What a booking page puts in an inbox.
 *
 *  Until now the only thing an attendee received was the calendar invitation
 *  Google writes on the host's behalf, which reaches a calendar and nothing else.
 *  This is the confirmation the moment they book, and the reminders before the
 *  meeting.
 *
 *  Both go through the composer a sequence step uses, from the host's own
 *  mailbox, so there is one place that holds a Google credential and one place
 *  that knows how to put a message on the wire. No new transport, and no second
 *  set of bugs about threading and encoding. */

export type BookingMailFacts = {
  page: BookingPageConfig
  hostName: string
  hostEmail: string
  attendeeName: string
  attendeeEmail: string
  attendeeTimezone: string
  startsAt: Date
  companyName: string | null
  conferenceUrl: string | null
  rescheduleToken: string
  cancelToken: string
}

const splitName = (full: string): [string, string] => {
  const [first = '', ...rest] = full.trim().split(/\s+/).filter(Boolean)
  return [first, rest.join(' ')]
}

/** Where the meeting happens, as a sentence rather than a field name. A Zoom link
 *  that has not arrived yet renders as nothing, so the reminder does not promise
 *  a link that is not in it. */
const locationLine = (facts: BookingMailFacts): string => {
  if (facts.conferenceUrl) return `Join: ${facts.conferenceUrl}`
  if (facts.page.location === 'phone' && facts.page.locationDetail) {
    return `Call: ${facts.page.locationDetail}`
  }
  if (facts.page.location === 'custom' && facts.page.locationDetail) return facts.page.locationDetail
  return ''
}

/** The attendee's own timezone, always: they picked the time in it, and a
 *  reminder that names the host's morning is a missed meeting. */
export const bookingMailValues = (facts: BookingMailFacts): TemplateValues => {
  const [hostFirst, hostLast] = splitName(facts.hostName)
  const [attendeeFirst, attendeeLast] = splitName(facts.attendeeName)
  const zone = facts.attendeeTimezone

  return {
    'contact.firstname': attendeeFirst,
    'contact.lastname': attendeeLast,
    'contact.email': facts.attendeeEmail,
    'company.name': facts.companyName?.trim() || facts.page.companyFallback,
    'host.firstname': hostFirst,
    'host.lastname': hostLast,
    // No signature is stored anywhere yet, so the honest one is the host's name
    // over the account's. Better than an empty sign-off, and it becomes the
    // stored signature the day there is one.
    'host.signature': [facts.hostName, facts.page.accountName].filter(Boolean).join('\n'),
    'meeting.date': facts.startsAt.toLocaleDateString('en-GB', {
      timeZone: zone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
    'meeting.time': `${facts.startsAt.toLocaleTimeString('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
    })} (${zone})`,
    'meeting.location': locationLine(facts),
    'meeting.description': renderTemplate(facts.page.descriptionTpl, {
      'contact.first_name': attendeeFirst,
      'contact.last_name': attendeeLast,
      'contact.full_name': facts.attendeeName,
      'contact.email': facts.attendeeEmail,
      'company.name': facts.companyName?.trim() || facts.page.companyFallback,
      'host.name': facts.hostName,
      'host.email': facts.hostEmail,
      'page.name': facts.page.name,
      'meeting.duration': `${facts.page.durationMinutes} minutes`,
    }),
  }
}

/** Every mail from a booking page carries these, because the calendar invitation
 *  is not the only place somebody looks when they need to move a meeting. */
const manageLines = (facts: BookingMailFacts): string =>
  [
    '',
    `Need a different time? ${publicBaseUrl}${bookingManagePath('reschedule', facts.rescheduleToken)}`,
    `Cannot make it? ${publicBaseUrl}${bookingManagePath('cancel', facts.cancelToken)}`,
  ].join('\n')

/** Which mailbox this goes out of.
 *
 *  The host's own, so a reply lands with the person the meeting is with. Failing
 *  that, any mailbox in the account that can send, because a reminder from the
 *  wrong colleague still gets somebody to the call. Failing that, nothing: Rawr
 *  has no transport of its own and pretending otherwise would swallow the mail. */
const sendingMailbox = async (
  ctx: AccountContext,
  hostUserId: string,
): Promise<{ id: string; email: string } | null> => {
  const boxes = await listMailboxes(ctx)
  const usable = boxes.filter((box) => box.canSend && box.state !== 'revoked')
  const own = usable.find((box) => box.userId === hostUserId)
  const chosen = own ?? usable[0]
  return chosen ? { id: chosen.id, email: chosen.email } : null
}

export type BookingMailOutcome = { sent: boolean; reason: string | null }

type SendInput = {
  accountId: string
  hostUserId: string
  contactId: string | null
  bookingId: string
  facts: BookingMailFacts
  kind: 'confirmation' | 'reminder'
  /** Names the reminder in the notice when there is nowhere to send from, so the
   *  host can tell which of three reminders went missing. */
  label: string
}

export const sendBookingMail = async (input: SendInput): Promise<BookingMailOutcome> => {
  const ctx = systemContext(input.accountId)
  const { facts } = input
  const values = bookingMailValues(facts)

  const subjectTpl =
    input.kind === 'confirmation'
      ? (facts.page.confirmationSubject ?? DEFAULT_CONFIRMATION_SUBJECT)
      : (facts.page.reminderSubject ?? DEFAULT_REMINDER_SUBJECT)
  const bodyTpl =
    input.kind === 'confirmation'
      ? (facts.page.confirmationBody ?? DEFAULT_CONFIRMATION_BODY)
      : (facts.page.reminderBody ?? DEFAULT_REMINDER_BODY)

  const subject = renderTemplate(subjectTpl, values) || facts.page.name
  const text = `${renderTemplate(bodyTpl, values)}\n${manageLines(facts)}`

  const box = await sendingMailbox(ctx, input.hostUserId)
  if (!box) {
    const reason =
      'No mailbox in this account is connected for sending, so the meeting mail could not go out.'
    await withAccount(ctx, (tx) =>
      notify(tx, ctx, {
        kind: 'integration_error',
        // One notice per booking per kind: three reminders on one meeting with no
        // mailbox is one problem, not three.
        dedupeKey: `booking:${input.kind}:${input.bookingId}`,
        title: `${facts.page.name}: the ${input.label} to ${facts.attendeeEmail} was not sent`,
        body: reason,
        entity: 'booking',
        entityId: input.bookingId,
        to: { userIds: [input.hostUserId] },
      }),
    )
    return { sent: false, reason }
  }

  await compose(ctx, {
    mailboxId: box.id,
    to: facts.attendeeEmail,
    subject,
    text,
    contactId: input.contactId,
  })
  return { sent: true, reason: null }
}
