import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BookingPageConfig } from '@rawr/db'
import { bookingMailValues, hostMailbox, type BookingMailFacts } from './booking-mail.ts'

const box = (userId: string, canSend = true, state = 'connected') => ({ userId, canSend, state })

test('a meeting mail goes out of the host\'s own mailbox', () => {
  const own = box('yash')
  assert.equal(hostMailbox([box('andika'), own], 'yash'), own)
})

test('with no mailbox of the host\'s that can send, a colleague\'s is never borrowed', () => {
  assert.equal(hostMailbox([box('andika'), box('yash', false)], 'yash'), undefined)
  assert.equal(hostMailbox([box('andika'), box('yash', true, 'revoked')], 'yash'), undefined)
  assert.equal(hostMailbox([box('andika')], 'yash'), undefined)
})

const facts = (attendeeLocale: string | null): BookingMailFacts => ({
  page: { companyFallback: '', accountName: 'Acme', descriptionTpl: '', location: 'phone', locationDetail: null } as unknown as BookingPageConfig,
  hostName: 'Sam Host',
  hostEmail: 'sam@acme.test',
  attendeeName: 'Priya Raman',
  attendeeEmail: 'priya@x.test',
  attendeeTimezone: 'Asia/Jakarta',
  attendeeLocale,
  startsAt: new Date('2026-09-07T17:00:00Z'),
  companyName: null,
  conferenceUrl: null,
  rescheduleToken: 'r',
  cancelToken: 'c',
})

const plain = (text: string | null | undefined): string => (text ?? '').replace(/\s/g, ' ')

test('the date and time read the way the attendee reads them, in their own zone', () => {
  const german = bookingMailValues(facts('de-DE'))
  assert.equal(plain(german['meeting.date']), 'Dienstag, 8. September 2026')
  assert.equal(plain(german['meeting.time']), '0:00 (Asia/Jakarta)')
  const american = bookingMailValues(facts('en-US'))
  assert.equal(plain(american['meeting.date']), 'Tuesday, September 8, 2026')
  assert.equal(plain(american['meeting.time']), '12:00 AM (Asia/Jakarta)')
})

test('a booking from before the language was kept reads in the fallback', () => {
  assert.equal(plain(bookingMailValues(facts(null))['meeting.date']), 'Tuesday, September 8, 2026')
})
