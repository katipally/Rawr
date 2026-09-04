import assert from 'node:assert/strict'
import { test } from 'node:test'
import { channelOfSession, clampRange, MAX_DAYS, readAttribution, sourceFrom } from '../index.ts'

/** Which bucket a visit lands in decides which channel gets credit for the money
 *  it eventually produced, so the rules are worth pinning down. */

const channel = (input: { rawQuery?: string; referrer?: string }) =>
  sourceFrom(readAttribution(input)).channel

test('a paid click id wins over whatever the referrer says', () => {
  // Google sends the visitor, so the referrer says Organic. The gclid says the
  // click was bought, and that is the true answer.
  assert.equal(
    channel({ rawQuery: '?gclid=abc123', referrer: 'https://www.google.com/' }),
    'Paid Search',
  )
})

test('a cpc medium is paid whoever referred it', () => {
  assert.equal(channel({ rawQuery: '?utm_medium=cpc&utm_source=bing' }), 'Paid Search')
})

test('an email campaign is email, not a referral', () => {
  assert.equal(
    channel({ rawQuery: '?utm_medium=email&utm_source=newsletter', referrer: 'https://mail.google.com/' }),
    'Email Marketing',
  )
})

test('a search engine referrer with no tags is organic', () => {
  assert.equal(channel({ referrer: 'https://duckduckgo.com/' }), 'Organic Search')
})

test('a social referrer is social', () => {
  assert.equal(channel({ referrer: 'https://www.linkedin.com/feed/' }), 'Social Media')
})

test('anything else with a referrer is a referral', () => {
  assert.equal(channel({ referrer: 'https://news.ycombinator.com/' }), 'Referrals')
})

test('no referrer and no tags is direct', () => {
  assert.equal(channel({}), 'Direct Traffic')
})

test('a referrer that is not a URL is still a referral, not a crash', () => {
  assert.equal(channel({ referrer: 'android-app' }), 'Referrals')
})

test('a session is read from the query keys as they arrived', () => {
  // The tracker stores utm as the raw parameters, keys and all, so the paid click
  // id is there to be found rather than lost to a five-key allowlist.
  assert.equal(
    channelOfSession({
      referrer: 'https://www.google.com/',
      utm: { utm_source: 'newsletter', gclid: 'abc123' },
    }),
    'Paid Search',
  )
})

test('a session with nothing on it is direct', () => {
  assert.equal(channelOfSession({ referrer: null, utm: {} }), 'Direct Traffic')
})

test('the raw query is kept whole, so a tag nobody has heard of yet survives', () => {
  const attribution = readAttribution({ rawQuery: '?li_fat_id=9&something_new=1' })
  assert.equal(attribution.rawQuery, '?li_fat_id=9&something_new=1')
})

test('a range the wrong way round is the range they meant', () => {
  const range = clampRange({ from: '2026-03-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })
  assert.ok(range.from.getTime() < range.to.getTime())
  assert.equal(range.to.toISOString(), '2026-03-01T00:00:00.000Z')
})

test('a range reaching back to 1970 is cut to a year and a day', () => {
  const range = clampRange({ from: '1970-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000
  assert.equal(Math.round(days), MAX_DAYS)
})

test('no range at all is the last thirty days', () => {
  const range = clampRange({})
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000
  assert.equal(Math.round(days), 29)
})
