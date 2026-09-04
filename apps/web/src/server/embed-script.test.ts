import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildEmbedScript } from './embed-script.ts'

/** The embed is a string built on the server and run on somebody else's page, so
 *  nothing type-checks it and nothing runs it here. What can be checked is that
 *  the string is well formed, that it carries the states a visitor depends on,
 *  and that it stays small enough to be a good guest. */

const script = buildEmbedScript({
  baseUrl: 'https://rawr.example',
  policyVersion: '2026-01',
  consentCookie: 'rawr_consent',
  styles: '.rawr-form{}',
})

test('it is one self-contained expression with balanced braces', () => {
  assert.equal(script.trimStart().startsWith('/* Rawr embed.'), true)
  assert.equal(script.includes('(function () {'), true)
  let depth = 0
  for (const character of script) {
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    assert.equal(depth >= 0, true, 'a closing brace arrived before its opener')
  }
  assert.equal(depth, 0, 'the script does not close every brace it opens')
})

test('the checker the tests ran is the one that ships', () => {
  assert.equal(script.includes('function clientFieldError'), true)
  // Its own rules, not a paraphrase: if these vanish the browser has stopped
  // agreeing with the server.
  assert.equal(script.includes('is not an email address.'), true)
  assert.equal(script.includes('is not in the expected format.'), true)
})

test('and so are the formatters the other surfaces use', () => {
  for (const name of ['countdown', 'formRedirecting', 'formStep']) {
    assert.equal(script.includes('function ' + name), true, `${name} is missing`)
  }
})

test('every state a visitor waits through is in there', () => {
  assert.equal(script.includes('Sending…'), true)
  assert.equal(script.includes('Nothing was lost'), true)
  assert.equal(script.includes('appear to be offline'), true)
  assert.equal(script.includes('Try again'), true)
  assert.equal(script.includes('Check the highlighted answers.'), true)
})

test('a field that fails is announced, not only coloured', () => {
  assert.equal(script.includes("setAttribute('aria-invalid', 'true')"), true)
  assert.equal(script.includes("setAttribute('aria-describedby'"), true)
  assert.equal(script.includes("role: 'alert'"), true)
})

test('the submit button says it is working and can be restored', () => {
  assert.equal(script.includes("setAttribute('aria-busy', 'true')"), true)
  assert.equal(script.includes("data-label"), true)
})

test('being offline is asked before the request, not inferred from its failure', () => {
  assert.equal(script.includes('navigator.onLine === false'), true)
})

test('the first thing wrong is what gets focused', () => {
  assert.equal(script.includes('function focusField'), true)
  assert.equal(script.includes('scrollIntoView'), true)
})

test('a redirect counts down in view rather than replacing the page instantly', () => {
  assert.equal(script.includes('REDIRECT_SECONDS'), true)
  assert.equal(script.includes('Go there now'), true)
})

test('the configuration is escaped rather than pasted in', () => {
  const built = buildEmbedScript({
    baseUrl: 'https://rawr.example/</script>',
    policyVersion: "2026-01'; alert(1); //",
    consentCookie: 'rawr_consent',
    styles: '.x{}',
  })
  // Every value arrives as a JSON literal that parses back to what went in, so
  // an edit that interpolates one of these bare fails here rather than on
  // somebody's site.
  for (const [name, value] of [
    ['BASE', 'https://rawr.example/</script>'],
    ['POLICY', "2026-01'; alert(1); //"],
  ]) {
    const assigned = built.match(new RegExp('var ' + name + ' = (.+);\\n'))?.[1]
    assert.notEqual(assigned, undefined, `${name} is not assigned`)
    assert.equal(JSON.parse(assigned ?? ''), value)
  }
})

test('it stays small enough to be a good guest on somebody else\'s page', () => {
  // Unminified and uncompressed. The budget is generous on purpose: what matters
  // is noticing a tenfold jump, not policing a few hundred bytes.
  assert.equal(script.length < 40_000, true, `the embed is ${script.length} bytes`)
})
