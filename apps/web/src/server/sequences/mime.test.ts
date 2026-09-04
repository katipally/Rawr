import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildMessage, encodeHeader, quotedPrintable, rewriteLinks } from './mime.ts'

/** What goes on the wire. A wrong header here is a mail that threads as a new
 *  conversation, arrives as mojibake, or cannot be unsubscribed from. */

const decode = (raw: string): string => Buffer.from(raw, 'base64url').toString('utf8')

/** Quoted-printable folds long lines with a trailing '='; a mail client removes
 *  those before rendering, so an assertion about a URL has to as well. */
const unfolded = (raw: string): string => decode(raw).replaceAll('=\r\n', '')

const build = (over: Partial<Parameters<typeof buildMessage>[0]> = {}) =>
  buildMessage({
    from: { name: 'Sales', address: 'sales@datasaur.ai' },
    to: 'prospect@partner.example',
    subject: 'Trial questions',
    text: 'Hello there.',
    html: '<p>Hello there.</p>',
    ...over,
  })

test('the message carries the headers a reply will be matched against', () => {
  const built = build()
  const raw = decode(built.raw)
  assert.equal(raw.includes(`Message-ID: ${built.internetMessageId}`), true)
  assert.equal(built.internetMessageId.startsWith('<'), true)
  assert.equal(built.internetMessageId.includes('@datasaur.ai>'), true)
})

test('a reply sets In-Reply-To and References, so it threads', () => {
  const raw = decode(build({ inReplyTo: '<first@datasaur.ai>' }).raw)
  assert.equal(raw.includes('In-Reply-To: <first@datasaur.ai>'), true)
  assert.equal(raw.includes('References: <first@datasaur.ai>'), true)
})

test('an explicit References chain is kept whole', () => {
  const raw = decode(build({ inReplyTo: '<b@x>', references: ['<a@x>', '<b@x>'] }).raw)
  assert.equal(raw.includes('References: <a@x> <b@x>'), true)
})

test('a non-ASCII subject is encoded rather than sent raw', () => {
  assert.equal(encodeHeader('Trial questions — pricing').startsWith('=?UTF-8?B?'), true)
  assert.equal(encodeHeader('Plain subject'), 'Plain subject')
})

test('a newline cannot be smuggled into a header', () => {
  assert.equal(encodeHeader('Subject\r\nBcc: someone@else.example').includes('\n'), false)
})

test('one-click unsubscribe headers are set when there is a token', () => {
  const raw = decode(build({ trackingBase: 'https://links.datasaur.ai', unsubscribeToken: 'tok' }).raw)
  assert.equal(raw.includes('List-Unsubscribe: <https://links.datasaur.ai/u/one-click/tok>'), true)
  assert.equal(raw.includes('List-Unsubscribe-Post: List-Unsubscribe=One-Click'), true)
})

test('without a tracking base there is no unsubscribe header, rather than a broken link', () => {
  assert.equal(decode(build({ unsubscribeToken: 'tok' }).raw).includes('List-Unsubscribe'), false)
})

test('links are rewritten through the redirect and reported back', () => {
  const built = build({
    html: '<p><a href="https://datasaur.ai/pricing">Pricing</a></p>',
    trackingBase: 'https://links.datasaur.ai',
    sendToken: 'send1',
  })
  assert.equal(built.links.length, 1)
  assert.equal(built.links[0]?.url, 'https://datasaur.ai/pricing')
  assert.equal(unfolded(built.raw).includes(`links.datasaur.ai/t/c/${built.links[0]?.token}`), true)
})

test('a mailto or an anchor is left alone', () => {
  const { links } = rewriteLinks('<a href="mailto:x@y.z">m</a><a href="#top">t</a>', 'https://l.example', () => false)
  assert.equal(links.length, 0)
})

test('the unsubscribe link itself is never rewritten through the tracker', () => {
  const built = build({
    html: '<a href="https://links.datasaur.ai/u/tok">Unsubscribe</a><a href="https://datasaur.ai">Us</a>',
    trackingBase: 'https://links.datasaur.ai',
    unsubscribeToken: 'tok',
    sendToken: 'send1',
  })
  assert.equal(built.links.length, 1)
  assert.equal(built.links[0]?.url, 'https://datasaur.ai')
})

test('the pixel is added when opens are tracked and omitted when they are not', () => {
  assert.equal(unfolded(build({ trackingBase: 'https://l.example', sendToken: 's' }).raw).includes('/t/o/s'), true)
  assert.equal(
    unfolded(build({ trackingBase: 'https://l.example', sendToken: 's', trackOpens: false }).raw).includes('/t/o/s'),
    false,
  )
})

test('a text-only message is not sent as multipart', () => {
  const raw = decode(build({ html: null }).raw)
  assert.equal(raw.includes('multipart/alternative'), false)
  assert.equal(raw.includes('text/plain'), true)
})

test('quoted-printable keeps ASCII readable and encodes the rest', () => {
  assert.equal(quotedPrintable('Hello there.'), 'Hello there.')
  assert.equal(quotedPrintable('café'), 'caf=C3=A9')
  assert.equal(quotedPrintable('a=b'), 'a=3Db')
})

test('a very long line is folded, so the message stays inside the line limit', () => {
  const folded = quotedPrintable('x'.repeat(200))
  assert.equal(folded.split('\r\n').every((line) => line.length <= 76), true)
  assert.equal(folded.includes('=\r\n'), true)
})

test('a display name with a comma is quoted, so it stays one recipient', () => {
  const raw = decode(build({ from: { name: 'Smith, Trevor', address: 'trevor@datasaur.ai' } }).raw)
  assert.equal(/From: ".*" <trevor@datasaur\.ai>/.test(raw), true)
})
