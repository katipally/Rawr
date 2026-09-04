import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readCategories, readHubSpotConsent } from './consent.ts'

/** Day one of cutover: a visitor who already chose under HubSpot's banner must
 *  not be asked again. HubSpot writes "1:true,2:false"; anything we misread here
 *  is either a second banner in their face or analytics running without consent,
 *  and only one of those two is merely annoying. */

test('a HubSpot cookie translates to the two categories', () => {
  assert.deepEqual(readHubSpotConsent('1:true,2:true'), { analytics: true, advertisement: true })
  assert.deepEqual(readHubSpotConsent('1:true,2:false'), { analytics: true, advertisement: false })
  assert.deepEqual(readHubSpotConsent('1:false,2:false'), { analytics: false, advertisement: false })
})

test('spacing and category order do not change the answer', () => {
  assert.deepEqual(readHubSpotConsent(' 2:true , 1:false '), { analytics: false, advertisement: true })
})

test('a category HubSpot added that we do not know is ignored, not guessed', () => {
  assert.deepEqual(readHubSpotConsent('1:true,3:true'), { analytics: true, advertisement: false })
})

test('nothing recognisable means no stored choice, so the banner still shows', () => {
  for (const input of [null, undefined, '', 'nonsense', '3:true', ':']) {
    assert.equal(readHubSpotConsent(input), null, String(input))
  }
})

test('a truncated cookie is no choice, not a refusal', () => {
  // "1" with nothing after it is a cookie that got cut, not somebody declining.
  // Reading it as a refusal recorded a decision nobody made and suppressed the
  // banner, so the person was never asked again.
  assert.equal(readHubSpotConsent('1'), null)
  assert.equal(readHubSpotConsent('1,2'), null)
  // One good half still counts, and the missing half stays false.
  assert.deepEqual(readHubSpotConsent('1:true,2'), { analytics: true, advertisement: false })
})

test('anything but "true" reads as a refusal', () => {
  // The safe direction: only an explicit "true" is consent.
  assert.deepEqual(readHubSpotConsent('1:TRUE,2:1'), { analytics: false, advertisement: false })
})

test('readCategories accepts only a complete, correctly typed choice', () => {
  assert.deepEqual(readCategories({ analytics: true, advertisement: false }), {
    necessary: true,
    analytics: true,
    advertisement: false,
  })
  for (const input of [null, 'x', 42, {}, { analytics: true }, { analytics: 'true', advertisement: false }]) {
    assert.equal(readCategories(input), null, JSON.stringify(input))
  }
})

test('necessary is always true and is never taken from the caller', () => {
  const parsed = readCategories({ analytics: false, advertisement: false, necessary: false })
  assert.equal(parsed?.necessary, true)
})
