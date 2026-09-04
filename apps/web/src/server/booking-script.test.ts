import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBookingScript } from './booking-script.ts'

/** Same reasoning as embed-script.test.ts: the widget is a string nothing
 *  type-checks and nothing here runs, so what is checked is that it is well
 *  formed, carries the states a visitor waits through, and stays small. */

const script = buildBookingScript({ baseUrl: 'https://rawr.example', styles: '.rawr-b{}' })

test('it is one self-contained expression with balanced braces', () => {
  assert.equal(script.includes('(function () {'), true)
  let depth = 0
  for (const character of script) {
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    assert.equal(depth >= 0, true, 'a closing brace arrived before its opener')
  }
  assert.equal(depth, 0, 'the script does not close every brace it opens')
})

test('the formatters the tests ran are the ones that ship', () => {
  for (const name of ['countdown', 'bookingHeld', 'bookingNextAvailable']) {
    assert.equal(script.includes('function ' + name), true, `${name} is missing`)
  }
  assert.equal(/\bimport\b|\brequire\(/.test(script.slice(script.indexOf('function countdown'))), false)
})

test('every state a visitor waits through is in there', () => {
  assert.equal(script.includes('Finding open times…'), true)
  assert.equal(script.includes('Booking…'), true)
  assert.equal(script.includes('You are booked.'), true)
  assert.equal(script.includes('while you were typing'), true)
  assert.equal(script.includes('Nothing was lost'), true)
  assert.equal(script.includes('appear to be offline'), true)
  assert.equal(script.includes('hold on that time has run out'), true)
})

test('a month that is being read draws the shape of the answer', () => {
  assert.equal(script.includes('function skeleton'), true)
  assert.equal(script.includes('rawr-b-skel'), true)
  // Six weeks, which is the most any month spans.
  assert.equal(script.includes('i < 42'), true)
})

test('the two waits are separate, so a later month does not show the earlier one', () => {
  assert.equal(script.includes('state.loadingMonth'), true)
})

test('the countdown is the server expiry, not a local guess', () => {
  assert.equal(script.includes('new Date(held.expiresAt)'), true)
  assert.equal(script.includes('state.hold.expiresAt - Date.now()'), true)
})

test('a slept tab re-reads the hold on the way back rather than waiting a tick', () => {
  assert.equal(script.includes('visibilitychange'), true)
})

test('an empty month says where to click next, and admits when there is nowhere', () => {
  assert.equal(script.includes('function emptyMonth'), true)
  assert.equal(script.includes('data.nextAvailable'), true)
  assert.equal(script.includes('Nothing is open at the moment'), true)
})

test('confirming says it is working', () => {
  assert.equal(script.includes("setAttribute('aria-busy', 'true')"), true)
})

test('being offline is asked before the request, not inferred from its failure', () => {
  assert.equal(script.includes('navigator.onLine === false'), true)
})

test('the confirmation offers the meeting as a file, for a calendar Google did not invite', () => {
  assert.equal(script.includes('payload.calendarUrl'), true)
  assert.equal(script.includes('Add to your calendar'), true)
})

test('the configuration is escaped rather than pasted in', () => {
  const built = buildBookingScript({ baseUrl: 'https://rawr.example/</script>', styles: '.x{}' })
  const assigned = built.match(/var BASE = (.+);\n/)?.[1]
  assert.equal(JSON.parse(assigned ?? ''), 'https://rawr.example/</script>')
})

test('it stays small enough to be a good guest on somebody else\'s page', () => {
  assert.equal(script.length < 40_000, true, `the widget is ${script.length} bytes`)
})
