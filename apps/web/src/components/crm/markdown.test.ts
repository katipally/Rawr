import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse, safeHref, tokenise } from './markdown.ts'

/** The half of Markdown worth testing: which links are safe to follow, and where
 *  the blocks are. Nothing here produces markup — the renderer builds React
 *  elements from these, so text a person typed reaches the page as text on every
 *  path. That is structural, and these are the decisions it rests on. */

test('only schemes a browser should follow survive', () => {
  for (const ok of ['https://example.com/a', 'http://example.com', 'mailto:x@example.com']) {
    assert.equal(safeHref(ok), ok)
  }
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ]) {
    assert.equal(safeHref(bad), null, bad)
  }
})

test('a link nobody should follow stays as the characters somebody wrote', () => {
  const tokens = tokenise('[click me](javascript:alert(1))')
  assert.ok(tokens.every((token) => token.kind !== 'link'), JSON.stringify(tokens))
  assert.ok(tokens.some((token) => token.text.includes('click me')))
})

test('nothing a person types becomes a token that carries markup', () => {
  // The renderer only ever emits strong, em, code, a and text. A script tag is
  // none of those, so it arrives at the page as characters.
  const tokens = tokenise('<script>alert(1)</script> and <img src=x onerror=y>')
  assert.ok(tokens.every((token) => token.kind === 'text'), JSON.stringify(tokens))
  assert.equal(tokens.map((token) => token.text).join(''), '<script>alert(1)</script> and <img src=x onerror=y>')
})

test('emphasis, code and links are read as themselves', () => {
  assert.deepEqual(tokenise('**bold**'), [{ kind: 'strong', text: 'bold' }])
  assert.deepEqual(tokenise('*thought*'), [{ kind: 'em', text: 'thought' }])
  assert.deepEqual(tokenise('`code`'), [{ kind: 'code', text: 'code' }])
  assert.deepEqual(tokenise('[go](https://example.com)'), [
    { kind: 'link', text: 'go', href: 'https://example.com' },
  ])
})

test('emphasis inside a code span stays literal', () => {
  // Otherwise somebody documenting Markdown cannot show what Markdown looks like.
  assert.deepEqual(tokenise('`**not bold**`'), [{ kind: 'code', text: '**not bold**' }])
})

test('a bare URL is a link without being written as one', () => {
  const tokens = tokenise('see https://example.com/x for more')
  assert.equal(tokens.filter((token) => token.kind === 'link').length, 1)
})

test('a run of bullets is one list, and a blank line starts a new block', () => {
  const blocks = parse('- one\n- two\n\nAfter')
  assert.equal(blocks.length, 2, JSON.stringify(blocks))
  assert.deepEqual(blocks[0], { kind: 'ul', items: ['one', 'two'] })
  assert.deepEqual(blocks[1], { kind: 'p', lines: ['After'] })
})

test('numbered lines are an ordered list', () => {
  assert.deepEqual(parse('1. first\n2) second'), [{ kind: 'ol', items: ['first', 'second'] }])
})

test('headings carry their level, up to three', () => {
  assert.deepEqual(parse('# One'), [{ kind: 'h', level: 1, text: 'One' }])
  assert.deepEqual(parse('### Three'), [{ kind: 'h', level: 3, text: 'Three' }])
  // Four hashes is not a heading anybody means; it reads as what was typed.
  assert.deepEqual(parse('#### Four'), [{ kind: 'p', lines: ['#### Four'] }])
})

test('wrapped lines are one paragraph, not several', () => {
  assert.deepEqual(parse('one\ntwo\nthree'), [{ kind: 'p', lines: ['one', 'two', 'three'] }])
})

test('nothing at all parses to nothing, rather than an empty block', () => {
  assert.deepEqual(parse(''), [])
  assert.deepEqual(parse('   \n  \n'), [])
})
