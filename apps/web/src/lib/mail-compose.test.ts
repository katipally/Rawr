import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  attachmentTotalError,
  linkTarget,
  megabytes,
  MAX_RECIPIENTS,
  normaliseAddress,
  readRecipients,
  replyAllRecipients,
} from './mail-compose.ts'

const fields = (to: string, cc = '', bcc = '') => ({ to, cc, bcc })

test('a bare address is lowercased and kept as the whole address', () => {
  assert.equal(normaliseAddress('Priya.Shah@Acme.Example'), 'priya.shah@acme.example')
})

test('an internationalised domain is written in the ASCII form mail routes on', () => {
  assert.equal(normaliseAddress('ana@bücher.example'), 'ana@xn--bcher-kva.example')
})

test('things that are not addresses are refused', () => {
  for (const bad of ['plain', '@acme.example', 'a@', 'a@b', 'a b@acme.example', 'a@acme.example/path', 'a@acme..example']) {
    assert.equal(normaliseAddress(bad), null, bad)
  }
})

test('people can be separated by commas or semicolons, and a quoted comma stays in its name', () => {
  const result = readRecipients(fields('"Smith, Trevor" <Trevor@Datasaur.ai>; ana@acme.example, bo@acme.example'))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(
    result.value.to.map((recipient) => [recipient.name, recipient.address]),
    [
      ['Smith, Trevor', 'trevor@datasaur.ai'],
      ['', 'ana@acme.example'],
      ['', 'bo@acme.example'],
    ],
  )
})

test('a name in curly quotes, as a word processor pastes it, keeps its comma too', () => {
  const result = readRecipients(fields('“Smith, Trevor” <trevor@datasaur.ai>, bo@acme.example'))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value.to.map((recipient) => [recipient.name, recipient.address]), [
    ['Smith, Trevor', 'trevor@datasaur.ai'],
    ['', 'bo@acme.example'],
  ])
})

test('a pasted list of Name <address> entries reads as the same people', () => {
  const result = readRecipients(fields('Ana Ruiz <ana@acme.example>, <bo@acme.example>, "Chen" <chen@acme.example>'))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value.to.map((recipient) => recipient.address), ['ana@acme.example', 'bo@acme.example', 'chen@acme.example'])
})

test('an entry that is not an address names itself and the field it is in', () => {
  const result = readRecipients(fields('ana@acme.example', 'nobody at all'))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.field, 'cc')
  assert.equal(result.error, 'That is not an email address: nobody at all')
})

test('an empty To is refused with a plain sentence, and empty Cc and Bcc are fine', () => {
  const empty = readRecipients(fields('  '))
  assert.deepEqual(empty, { ok: false, field: 'to', error: 'Add someone to send it to.' })
  assert.equal(readRecipients(fields('ana@acme.example')).ok, true)
})

test('an address listed twice goes out once, kept where it first appears', () => {
  const result = readRecipients(fields('ana@acme.example, Bo@acme.example', 'bo@acme.example, ANA@acme.example', 'bo@acme.example'))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value.to.map((recipient) => recipient.address), ['ana@acme.example', 'bo@acme.example'])
  assert.deepEqual(result.value.cc, [])
  assert.deepEqual(result.value.bcc, [])
})

test('more recipients than the limit are refused, and the message names the limit and the count', () => {
  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, index) => `person${index}@acme.example`).join(', ')
  const result = readRecipients(fields(many))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, `A message can have at most ${MAX_RECIPIENTS} recipients. This one has ${MAX_RECIPIENTS + 1}.`)
  const atLimit = Array.from({ length: MAX_RECIPIENTS }, (_, index) => `p${index}@acme.example`).join(', ')
  assert.equal(readRecipients(fields(atLimit)).ok, true)
})

test('a very long list is read without a limit on its text, and only its people are counted', () => {
  const repeated = Array.from({ length: 5000 }, () => 'same@acme.example').join(', ')
  const result = readRecipients(fields(repeated))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.to.length, 1)
})

test('reply all sends to the newest sender and copies everyone else on it, minus our own addresses', () => {
  const result = replyAllRecipients(
    {
      from: 'Client@Acme.example',
      to: ['sales@datasaur.ai', 'ana@acme.example'],
      cc: ['bo@acme.example', 'SALES@datasaur.ai', 'ana@acme.example'],
    },
    ['sales@datasaur.ai', 'support@datasaur.ai'],
  )
  assert.deepEqual(result, { to: ['Client@Acme.example'], cc: ['ana@acme.example', 'bo@acme.example'] })
})

test('reply all to our own mail goes back to whoever it was sent to', () => {
  const result = replyAllRecipients(
    { from: null, to: ['ana@acme.example', 'sales@datasaur.ai'], cc: ['bo@acme.example'] },
    ['sales@datasaur.ai'],
  )
  assert.deepEqual(result, { to: ['ana@acme.example'], cc: ['bo@acme.example'] })
})

test('reply all never repeats the sender in Cc', () => {
  const result = replyAllRecipients({ from: 'ana@acme.example', to: ['ana@acme.example'], cc: [] }, [])
  assert.deepEqual(result, { to: ['ana@acme.example'], cc: [] })
})

test('the size limit names the limit and the total to one decimal, rounded up', () => {
  assert.equal(attachmentTotalError(25 * 1024 * 1024), null)
  assert.equal(
    attachmentTotalError(Math.round(31.2 * 1024 * 1024)),
    'Attachments can be 25 MB in total. This message has 31.2 MB.',
  )
  assert.equal(attachmentTotalError(25 * 1024 * 1024 + 1), 'Attachments can be 25 MB in total. This message has 25.1 MB.')
  assert.equal(megabytes(1024 * 1024 * 1.01), '1.1')
})

test('a link becomes a web, mail or bare-host address, and nothing else', () => {
  assert.equal(linkTarget('datasaur.ai/pricing'), 'https://datasaur.ai/pricing')
  assert.equal(linkTarget('http://datasaur.ai'), 'http://datasaur.ai')
  assert.equal(linkTarget('ana@acme.example'), 'mailto:ana@acme.example')
  assert.equal(linkTarget('mailto:ana@acme.example'), 'mailto:ana@acme.example')
  assert.equal(linkTarget('javascript:alert(1)'), null)
  assert.equal(linkTarget('data:text/html,hi'), null)
  assert.equal(linkTarget('   '), null)
  assert.equal(linkTarget(`https://a.example/${'x'.repeat(3000)}`), null)
})
