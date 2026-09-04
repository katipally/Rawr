import assert from 'node:assert/strict'
import { test } from 'node:test'
import { htmlToText, parseAddresses, sanitiseHtml } from './gmail.ts'

/** The two things standing between a stranger's mail and this app: what we read
 *  out of the headers, and what we refuse to keep out of the body. */

test('an address is taken out of a display name', () => {
  assert.deepEqual(parseAddresses('Trevor Smith <trevor@datasaur.ai>'), ['trevor@datasaur.ai'])
})

test('a comma inside a quoted display name is not a separator', () => {
  assert.deepEqual(parseAddresses('"Smith, Trevor" <trevor@datasaur.ai>, ivan@datasaur.ai'), [
    'trevor@datasaur.ai',
    'ivan@datasaur.ai',
  ])
})

test('anything without an at sign is dropped rather than stored as an address', () => {
  assert.deepEqual(parseAddresses('undisclosed-recipients:;'), [])
})

test('script and style elements are removed whole', () => {
  const cleaned = sanitiseHtml('<p>Hi</p><script>steal()</script><style>body{}</style>')
  assert.equal(cleaned.includes('script'), false)
  assert.equal(cleaned.includes('steal'), false)
  assert.equal(cleaned.includes('<p>Hi</p>'), true)
})

test('event handlers go, quoted, single-quoted or bare', () => {
  const cleaned = sanitiseHtml(`<a href="#" onclick="x()" onmouseover='y()' onfocus=z()>Hi</a>`)
  assert.equal(/on(click|mouseover|focus)/i.test(cleaned), false)
  assert.equal(cleaned.includes('href="#"'), true)
})

test('a javascript: link is defused rather than the whole tag dropped', () => {
  const cleaned = sanitiseHtml('<a href="javascript:alert(1)">Click</a>')
  assert.equal(cleaned.includes('javascript:'), false)
  assert.equal(cleaned.includes('Click'), true)
})

test('a data: URL cannot smuggle a document in through an image', () => {
  assert.equal(sanitiseHtml('<img src="data:text/html,<script>x</script>">').includes('data:'), false)
})

test('frames, forms and objects are removed, self-closing or not', () => {
  const cleaned = sanitiseHtml('<iframe src="x"></iframe><form action="/x"><input></form><object data="y"></object>')
  assert.equal(/iframe|<form|<object/i.test(cleaned), false)
})

test('ordinary formatting survives, because that is the point of keeping the HTML', () => {
  const kept = sanitiseHtml('<p>Hi <b>there</b></p><blockquote>quoted</blockquote><img src="https://x/y.png">')
  assert.equal(kept.includes('<b>there</b>'), true)
  assert.equal(kept.includes('blockquote'), true)
  assert.equal(kept.includes('https://x/y.png'), true)
})

test('flattening to text keeps the words and the line breaks', () => {
  const text = htmlToText('<p>One</p><p>Two</p><br>Three&nbsp;&amp;&nbsp;four')
  assert.equal(text.includes('One'), true)
  assert.equal(text.includes('Two'), true)
  assert.equal(text.includes('Three & four'), true)
  assert.equal(text.includes('<'), false)
})
