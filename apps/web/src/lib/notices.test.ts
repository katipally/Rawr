import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NOTICES, noticeFor } from './notices.ts'

test('every code has a sentence and no em dash', () => {
  for (const [code, sentence] of Object.entries(NOTICES)) {
    assert.equal(noticeFor(code), sentence)
    assert.ok(sentence.length > 0 && !sentence.includes('—'), code)
  }
})

test('anything that is not a known code renders nothing', () => {
  for (const unknown of [undefined, null, '', 'x', 'Call 555-0100', 'SIGNIN_CANCELLED', ['signin_cancelled'], 42, {}]) {
    assert.equal(noticeFor(unknown), null)
  }
})

test('inherited object keys are not codes', () => {
  for (const key of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf']) {
    assert.equal(noticeFor(key), null)
  }
})

test('text supplied in the address never reaches the output', () => {
  const sentences = new Set<string>(Object.values(NOTICES))
  for (const spoof of ['<img src=x onerror=1>', 'https://evil.test/login', 'Your account is locked, call 555-0100']) {
    const out = noticeFor(spoof)
    assert.equal(out, null)
    assert.ok(![...sentences].some((sentence) => sentence.includes(spoof)))
  }
})
