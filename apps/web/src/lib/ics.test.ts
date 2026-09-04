import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildIcs } from './ics.ts'

/** A calendar file that is subtly wrong imports fine in one client and silently
 *  fails in another, which is exactly the bug nobody reports. */

const event = {
  uid: 'booking-1@rawr',
  startsAt: new Date('2026-09-07T14:30:00Z'),
  endsAt: new Date('2026-09-07T15:00:00Z'),
  summary: 'Intro call',
  organiser: { name: 'Trevor Hale', email: 'trevor@example.com' },
  attendee: { name: 'Sam Okafor', email: 'sam@example.net' },
}

test('every line ends CRLF, including the last', () => {
  const ics = buildIcs(event)
  assert.equal(ics.endsWith('END:VCALENDAR\r\n'), true)
  assert.equal(/[^\r]\n/.test(ics), false, 'a bare newline slipped in')
})

test('instants are written as UTC, so the reader sees their own zone', () => {
  const ics = buildIcs(event)
  assert.equal(ics.includes('DTSTART:20260907T143000Z'), true)
  assert.equal(ics.includes('DTEND:20260907T150000Z'), true)
})

test('a comma in a company name does not become two values', () => {
  const ics = buildIcs({ ...event, summary: 'Intro call: Acme, Inc; phase 1 \\ 2' })
  assert.equal(ics.includes('SUMMARY:Intro call: Acme\\, Inc\\; phase 1 \\\\ 2'), true)
})

test('a newline in the description is escaped rather than ending the property', () => {
  const ics = buildIcs({ ...event, description: 'Line one\nLine two' })
  assert.equal(ics.includes('\\nLine two'), true)
  assert.equal(ics.includes('DESCRIPTION:Line one\r\nLine two'), false)
})

test('long lines fold, and unfold back to what went in', () => {
  const long = 'Quarterly business review with the whole revenue team and their guests'.repeat(3)
  const ics = buildIcs({ ...event, summary: long })
  const folded = ics.split('\r\n').find((line) => line.startsWith('SUMMARY:'))
  assert.equal((folded?.length ?? 0) <= 75, true, 'the first line is over the limit')
  const unfolded = ics.replace(/\r\n /g, '')
  assert.equal(unfolded.includes('SUMMARY:' + long), true)
})

test('folding counts octets, so an accented name is not cut in half', () => {
  const ics = buildIcs({ ...event, summary: 'é'.repeat(90) })
  const encoder = new TextEncoder()
  for (const line of ics.split('\r\n')) {
    assert.equal(encoder.encode(line).length <= 75, true, `a line is ${encoder.encode(line).length} octets`)
  }
  assert.equal(ics.replace(/\r\n /g, '').includes('SUMMARY:' + 'é'.repeat(90)), true)
})

test('a cancellation says so in both places a calendar looks', () => {
  const ics = buildIcs({ ...event, cancelled: true, sequence: 1 })
  assert.equal(ics.includes('METHOD:CANCEL'), true)
  assert.equal(ics.includes('STATUS:CANCELLED'), true)
  assert.equal(ics.includes('SEQUENCE:1'), true)
})

test('the same meeting keeps the same uid, so a re-import updates rather than duplicates', () => {
  assert.equal(buildIcs(event).includes('UID:booking-1@rawr'), true)
})
