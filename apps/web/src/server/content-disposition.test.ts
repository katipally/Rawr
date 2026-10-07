import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachment } from './content-disposition.ts'

/** What a browser would read back: the header must be a legal ByteString. */
const asHeader = (filename: string): string => new Headers({ 'content-disposition': attachment(filename) }).get('content-disposition') ?? ''

test('a plain name is carried as is', () => {
  assert.equal(attachment('Leads - Q3-errors.csv'), `attachment; filename="Leads - Q3-errors.csv"; filename*=UTF-8''Leads%20-%20Q3-errors.csv`)
})

test('a quote or backslash cannot end the filename parameter', () => {
  const header = attachment('a"b\\c.csv')
  assert.match(header, /^attachment; filename="a_b_c\.csv"; /)
  assert.match(header, /filename\*=UTF-8''a%22b%5Cc\.csv$/)
})

test('a line break cannot split the header', () => {
  const header = asHeader('a\r\nSet-Cookie: x=1.csv')
  assert.equal(/[\r\n]/.test(header), false)
})

test('non-Latin-1 names build a header the Response constructor accepts', () => {
  for (const name of ['Leads \u2013 Q3.csv', '\u201Cquoted\u201D.csv', '\u30EA\u30FC\u30C9.csv', 'caf\u00E9.csv', 'launch \u{1F680}.csv']) {
    const header = asHeader(name)
    assert.doesNotThrow(() => new Response(null, { headers: { 'content-disposition': attachment(name) } }), name)
    assert.match(header, /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._~!-]*$/, name)
  }
})

test('the real name survives in filename*', () => {
  const encoded = /filename\*=UTF-8''(.*)$/.exec(attachment('Leads \u2013 Q3 (final).csv'))?.[1] ?? ''
  assert.equal(decodeURIComponent(encoded), 'Leads \u2013 Q3 (final).csv')
  assert.equal(encoded.includes('('), false)
})

test('a lone surrogate does not throw', () => {
  assert.doesNotThrow(() => attachment('bad\uD800name.csv'))
})

test('an empty name still yields a legal header', () => {
  assert.equal(attachment(''), `attachment; filename=""; filename*=UTF-8''`)
})
