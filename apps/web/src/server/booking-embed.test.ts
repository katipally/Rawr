import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBookingEmbed } from './booking-embed.ts'

/** Same reasoning as embed-script.test.ts: the loader is a string nothing
 *  type-checks and nothing here runs, so what is checked is that it is well formed,
 *  points at the one page that renders the widget, and stays small. */

const script = buildBookingEmbed({ baseUrl: 'https://rawr.example' })

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

test('it frames the hosted page rather than rebuilding the widget', () => {
  assert.equal(script.includes("'/b/' + address + '?embed=1'"), true)
  assert.equal(script.includes('createElement(\'iframe\')'), true)
  // A second renderer in here is the duplication this replaced.
  assert.equal(script.includes('/slots?'), false)
  assert.equal(script.includes('/confirm'), false)
})

test('it sizes itself to the widget inside it', () => {
  assert.equal(script.includes("data.source !== 'rawr-booking'"), true)
  assert.equal(script.includes("data.type !== 'height'"), true)
  // Only the frame that sent the message is resized, so one embed cannot set
  // another one's height.
  assert.equal(script.includes('frames[i].contentWindow === event.source'), true)
})

test('a frame that will not load still leaves a way to book', () => {
  assert.equal(script.includes('fallbackLink'), true)
  assert.equal(script.includes('Book a meeting'), true)
})

test('it mounts every placeholder exactly once', () => {
  assert.equal(script.includes("querySelectorAll('[data-rawr-booking]')"), true)
  assert.equal(script.includes("getAttribute('data-rawr-mounted')"), true)
})

test('it stays small enough to sit in somebody else’s page budget', () => {
  assert.equal(script.length < 4_000, true, `the loader is ${script.length} bytes`)
})

test('the only global it takes is its own', () => {
  assert.equal(script.includes('window.rawrBooking'), true)
  assert.equal(/window\.(?!rawrBooking|parent|addEventListener)[a-z]/i.test(script), false)
})
