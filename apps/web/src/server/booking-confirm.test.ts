import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BookingPageConfig, ConfirmResult } from '@rawr/db'
import { confirmationBody } from './booking-confirm.ts'

const page = {
  location: 'phone',
  locationDetail: '+62 811 000 111',
  redirectUrl: null,
  confirmationCopy: 'See you then.',
} as unknown as Pick<BookingPageConfig, 'location' | 'locationDetail' | 'redirectUrl' | 'confirmationCopy'>

const booking = (conferenceUrl: string | null) =>
  ({
    startsAt: new Date('2026-09-07T17:00:00Z'),
    endsAt: new Date('2026-09-07T17:30:00Z'),
    hostName: 'Sam Host',
    conferenceUrl,
    rescheduleToken: 'r',
    cancelToken: 'c',
    warnings: [],
  }) as unknown as Pick<
    ConfirmResult,
    'startsAt' | 'endsAt' | 'hostName' | 'conferenceUrl' | 'rescheduleToken' | 'cancelToken' | 'warnings'
  >

test('the confirmation JSON carries the place as the mail says it', () => {
  assert.equal(confirmationBody('acme', 'intro', page, booking(null)).where, 'Call: +62 811 000 111')
  assert.equal(
    confirmationBody('acme', 'intro', page, booking('https://zoom.test/j/1')).where,
    'Join: https://zoom.test/j/1',
  )
})
