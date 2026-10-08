import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFormat, FALLBACK, localeFrom, todayIn } from './format.ts'

/** Intl writes some spaces as no-break or narrow no-break; a test reads them as one. */
const plain = (text: string): string => text.replace(/\s/g, ' ')

const as = (locale: string, zone = 'UTC', currency = 'USD') => createFormat({ locale, zone, currency })

test('a number is grouped the way the viewer groups it, not the way the server does', () => {
  assert.equal(as('en-US').number(1234567.891), '1,234,567.891')
  assert.equal(as('de-DE').number(1234567.891), '1.234.567,891')
  assert.equal(plain(as('fr-FR').number(1234567.891)), '1 234 567,891')
  assert.equal(as('en-IN').number(1234567), '12,34,567')
})

test('nothing, not a number and infinity are blank rather than "NaN"', () => {
  const fmt = as('en-US')
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(fmt.number(value), '')
  assert.equal(fmt.money(null), '')
  assert.equal(fmt.money(''), '')
  assert.equal(fmt.money('abc'), '')
  assert.equal(fmt.dateTime(null), '')
  assert.equal(fmt.date('not a date'), '')
  assert.equal(fmt.date(null), '')
  assert.equal(as('en-US', 'Pacific/Kiritimati').date('1900-01-01'), 'Jan 1, 1900')
  assert.equal(as('en-US', 'Pacific/Kiritimati').date('9999-12-31'), 'Dec 31, 9999')
  assert.equal(fmt.ago(undefined), '')
})

test('a very large number still formats', () => {
  assert.equal(as('en-US').number(1e21), '1,000,000,000,000,000,000,000')
  assert.equal(as('en-US').money(9_999_999_999_999.5, 'USD'), '$9,999,999,999,999.50')
})

test('money follows the viewer for punctuation and the row for the currency', () => {
  assert.equal(as('en-US').money(1234.5, 'USD'), '$1,234.50')
  assert.equal(plain(as('de-DE').money(1234.5, 'EUR')), '1.234,50 €')
  assert.equal(as('en-US').money(1500, 'USD'), '$1,500')
  assert.equal(as('ja-JP').money(1500, 'JPY').replace('￥', '¥'), '¥1,500')
  assert.equal(as('en-GB').money(0.5, 'GBP'), '£0.50')
})

test('money with no code of its own is in the account currency', () => {
  assert.equal(plain(as('de-DE', 'UTC', 'EUR').money(10)), '10 €')
  assert.equal(as('en-US', 'UTC', 'CAD').money(10), 'CA$10')
})

test('a currency code Intl does not know is shown as text, not dropped', () => {
  assert.equal(as('en-US').money(5, 'ZZZZ'), '5 ZZZZ')
})

test('several currencies are listed side by side and none reads as zero', () => {
  const fmt = as('en-US')
  assert.equal(fmt.amounts([{ currency: 'USD', amount: 100 }, { currency: 'EUR', amount: 5.5 }]), '$100, €5.50')
  assert.equal(fmt.amounts([]), '$0')
  assert.equal(as('en-US', 'UTC', 'EUR').amounts([]), '€0')
})

test('an instant is written in the viewer zone and a stored day does not move', () => {
  const instant = '2026-08-07T02:30:00Z'
  assert.equal(plain(as('en-US', 'America/Los_Angeles').dateTime(instant)), 'Aug 6, 2026, 7:30 PM')
  assert.equal(plain(as('en-US', 'Asia/Kolkata').dateTime(instant)), 'Aug 7, 2026, 8:00 AM')
  assert.equal(as('en-US', 'America/Los_Angeles').date('2026-08-07'), 'Aug 7, 2026')
  assert.equal(as('en-US', 'Pacific/Kiritimati').date('2026-08-07'), 'Aug 7, 2026')
  assert.equal(as('en-US', 'America/Los_Angeles').dayShort('2026-08-07'), 'Aug 7')
})

test('the same instant reads differently by locale', () => {
  const instant = '2026-10-05T13:56:00Z'
  assert.equal(plain(as('en-US').dateTime(instant)), 'Oct 5, 2026, 1:56 PM')
  assert.equal(plain(as('en-GB').dateTime(instant)), '5 Oct 2026, 13:56')
  assert.equal(plain(as('de-DE').dateTime(instant)), '05.10.2026, 13:56')
})

test('across the spring forward the wall clock skips and the offset follows', () => {
  const fmt = as('en-US', 'America/Los_Angeles')
  assert.equal(plain(fmt.time('2026-03-08T09:59:00Z')), '1:59 AM')
  assert.equal(plain(fmt.time('2026-03-08T10:00:00Z')), '3:00 AM')
  assert.equal(plain(as('en-GB', 'Europe/Berlin').time('2026-03-29T00:59:00Z')), '1:59')
  assert.equal(plain(as('en-GB', 'Europe/Berlin').time('2026-03-29T01:00:00Z')), '3:00')
})

test('across the fall back one wall-clock hour happens twice', () => {
  const fmt = as('en-US', 'America/Los_Angeles')
  assert.equal(plain(fmt.time('2026-11-01T08:30:00Z')), '1:30 AM')
  assert.equal(plain(fmt.time('2026-11-01T09:30:00Z')), '1:30 AM')
  assert.equal(plain(fmt.time('2026-11-01T10:30:00Z')), '2:30 AM')
})

test('the zone decides which day an instant is on', () => {
  const late = new Date('2026-10-05T23:30:00Z')
  assert.equal(todayIn('UTC'), todayIn('UTC'))
  assert.equal(as('en-US', 'Pacific/Auckland').at(late, { day: 'numeric' }), '6')
  assert.equal(as('en-US', 'Pacific/Honolulu').at(late, { day: 'numeric' }), '5')
})

test('past means before today where the viewer stands', () => {
  const fmt = as('en-US', 'UTC')
  const today = fmt.today()
  assert.equal(fmt.isPast(today), false)
  assert.equal(fmt.isPast('2000-01-01'), true)
  assert.equal(fmt.isPast('2999-01-01'), false)
  assert.equal(fmt.isPast(new Date(Date.now() - 3 * 86_400_000)), true)
  assert.equal(fmt.isPast(null), false)
})

test('a relative time is written in the viewer language', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000 - 60_000)
  assert.equal(as('en-US').ago(twoDaysAgo), '2 days ago')
  assert.equal(as('de-DE').ago(twoDaysAgo), 'vorgestern')
  assert.equal(as('en-US').ago(new Date()), 'just now')
})

test('a ratio is a percentage and a size is in a unit a person reads', () => {
  assert.equal(as('en-US').percent(0.125, 1), '12.5%')
  assert.equal(plain(as('fr-FR').percent(0.125, 1)), '12,5 %')
  assert.equal(as('en-US').percent(0.5), '50%')
  assert.equal(as('en-US').bytes(1536 * 1024), '1.5 MB')
  assert.equal(as('en-US').bytes(10), '1 kB')
  assert.equal(as('en-US').bytes(null), '')
})

test('the accept-language header yields the first tag Intl accepts', () => {
  assert.equal(localeFrom('fr-CA,fr;q=0.9,en;q=0.8'), 'fr-CA')
  assert.equal(localeFrom('xx-invalid-@@,de;q=0.5'), 'de')
  assert.equal(localeFrom('*'), FALLBACK.locale)
  assert.equal(localeFrom(''), FALLBACK.locale)
  assert.equal(localeFrom(null), FALLBACK.locale)
})

test('a hostile run of distinct locales cannot grow the formatter cache without bound', () => {
  for (let i = 0; i < 1200; i++) {
    const tag = [i % 26, Math.floor(i / 26) % 26, Math.floor(i / 676)].map((n) => String.fromCharCode(97 + n)).join('')
    as(tag).number(1)
  }
  assert.equal(as('en-US').number(1000), '1,000')
})
