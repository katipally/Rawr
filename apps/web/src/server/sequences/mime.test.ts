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
    to: [{ address: 'prospect@partner.example' }],
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

const body = (raw: string): string => raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')
const headerBlock = (raw: string): string => raw.split('\r\n\r\n')[0] ?? ''

test('a message to several people, with copies, lists each address on its own folded line', () => {
  const raw = decode(
    build({
      to: [{ name: 'Ana Ruiz', address: 'ana@acme.example' }, { address: 'bo@acme.example' }],
      cc: [{ name: 'Chen', address: 'chen@acme.example' }],
    }).raw,
  )
  assert.equal(raw.includes('To: Ana Ruiz <ana@acme.example>,\r\n bo@acme.example\r\n'), true)
  assert.equal(raw.includes('Cc: Chen <chen@acme.example>\r\n'), true)
})

test('a Bcc header is written for delivery, and the people in it are not in To or Cc', () => {
  const raw = decode(build({ cc: [{ address: 'chen@acme.example' }], bcc: [{ address: 'hidden@acme.example' }] }).raw)
  assert.equal(raw.includes('Bcc: hidden@acme.example'), true)
  assert.equal(/^To: .*hidden/m.test(raw), false)
  assert.equal(/^Cc: .*hidden/m.test(raw), false)
})

test('a message with no copies has no Cc or Bcc header at all', () => {
  const raw = decode(build().raw)
  assert.equal(raw.includes('Cc:'), false)
  assert.equal(raw.includes('Bcc:'), false)
})

test('a long recipient list is folded, so no header line exceeds 998 characters', () => {
  const to = Array.from({ length: 100 }, (_, index) => ({ name: `Person ${index} ${'x'.repeat(40)}`, address: `p${index}@acme.example` }))
  const raw = decode(build({ to }).raw)
  assert.equal(raw.split('\r\n').every((line) => line.length <= 998), true)
})

test('a long non-ASCII subject becomes several encoded words, each within 75 characters', () => {
  const subject = 'Ångström résumé déjà vu '.repeat(12)
  const encoded = encodeHeader(subject)
  const words = encoded.split('\r\n ')
  assert.equal(words.length > 1, true)
  assert.equal(words.every((word) => word.length <= 75 && word.startsWith('=?UTF-8?B?') && word.endsWith('?=')), true)
  const decoded = words.map((word) => Buffer.from(word.slice(10, -2), 'base64').toString('utf8')).join('')
  assert.equal(decoded, subject.trim())
})

test('an attachment makes the message multipart/mixed, with the text before it and the file after', () => {
  const raw = decode(
    build({ attachments: [{ filename: 'terms.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4 hello') }] }).raw,
  )
  const boundary = /Content-Type: multipart\/mixed; boundary="([^"]+)"/.exec(raw)?.[1]
  assert.ok(boundary)
  assert.equal(raw.indexOf('multipart/alternative') > raw.indexOf('multipart/mixed'), true)
  assert.equal(raw.indexOf('text/html') < raw.indexOf('Content-Disposition: attachment'), true)
  assert.equal(raw.includes(`--${boundary}--`), true)
})

test('an attachment is base64 in lines of at most 76 characters and decodes to the same bytes', () => {
  const bytes = Buffer.from(Array.from({ length: 300 }, (_, index) => index % 256))
  const raw = decode(build({ attachments: [{ filename: 'data.bin', mime: 'application/octet-stream', bytes }] }).raw)
  const encoded = raw.slice(raw.indexOf('Content-Transfer-Encoding: base64'))
  const payload = encoded.split('\r\n\r\n')[1]?.split('\r\n--')[0] ?? ''
  assert.equal(payload.split('\r\n').every((line) => line.length <= 76), true)
  assert.equal(Buffer.from(payload.replaceAll('\r\n', ''), 'base64').equals(bytes), true)
})

test('an ASCII filename is quoted, and a non-ASCII one is an RFC 2231 parameter, never an encoded word', () => {
  const plain = decode(build({ attachments: [{ filename: 'terms.pdf', mime: 'application/pdf', bytes: Buffer.from('x') }] }).raw)
  assert.equal(plain.includes('filename="terms.pdf"'), true)
  const accented = decode(build({ attachments: [{ filename: 'résumé.pdf', mime: 'application/pdf', bytes: Buffer.from('x') }] }).raw)
  assert.equal(accented.includes("filename*0*=UTF-8''r%C3%A9sum%C3%A9.pdf"), true)
  assert.equal(accented.includes('=?UTF-8'), false)
})

test('a long filename is split into continuations, each line short enough to send', () => {
  const name = `${'é'.repeat(120)}.pdf`
  const raw = decode(build({ attachments: [{ filename: name, mime: 'application/pdf', bytes: Buffer.from('x') }] }).raw)
  assert.equal(/filename\*1\*=/.test(raw), true)
  const lines = raw.split('\r\n')
  assert.equal(lines.every((line) => line.length <= 998), true)
  const pieces = [...raw.matchAll(/filename\*(\d)\*=(?:UTF-8'')?([^;\r\n]+)/g)]
  const rebuilt = pieces.map((match) => decodeURIComponent(match[2] ?? '')).join('')
  assert.equal(rebuilt, name)
})

test('a file with no usable type is sent as bytes, and a stored type is kept', () => {
  const unknown = decode(build({ attachments: [{ filename: 'x', mime: '', bytes: Buffer.from('x') }] }).raw)
  assert.equal(unknown.includes('Content-Type: application/octet-stream'), true)
  const hostile = decode(build({ attachments: [{ filename: 'x', mime: 'text/html; charset=evil\r\nBcc: a@b.c', bytes: Buffer.from('x') }] }).raw)
  assert.equal(hostile.includes('Bcc: a@b.c'), false)
  assert.equal(hostile.includes('Content-Type: application/octet-stream'), true)
  const pdf = decode(build({ attachments: [{ filename: 'x', mime: 'Application/PDF', bytes: Buffer.from('x') }] }).raw)
  assert.equal(pdf.includes('Content-Type: application/pdf'), true)
})

test('a filename cannot inject a header line', () => {
  const raw = decode(build({ attachments: [{ filename: 'a\r\nBcc: x@y.z.pdf', mime: 'application/pdf', bytes: Buffer.from('x') }] }).raw)
  assert.equal(raw.includes('\r\nBcc:'), false)
})

test('a text-only message with copies still has no attachment structure', () => {
  const raw = decode(build({ html: null, cc: [{ address: 'c@acme.example' }] }).raw)
  assert.equal(raw.includes('multipart/mixed'), false)
  assert.equal(raw.includes('Cc: c@acme.example'), true)
})

test('an emoji in the text survives the quoted-printable encoding whole', () => {
  assert.equal(quotedPrintable('👋'), '=F0=9F=91=8B')
  assert.equal(quotedPrintable('ok 👋'), 'ok =F0=9F=91=8B')
})

test('the headers and the body are separated by a blank line, and the body is not part of any header', () => {
  const raw = decode(build({ attachments: [{ filename: 'a.txt', mime: 'text/plain', bytes: Buffer.from('hi') }] }).raw)
  assert.equal(headerBlock(raw).includes('Subject:'), true)
  assert.equal(body(raw).includes('Content-Disposition: attachment'), true)
})
