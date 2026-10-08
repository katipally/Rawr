import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'
import { loadsRemotely, localSvgRef, messageFrameSandbox } from './message-frame.ts'

test('a mail frame never runs script and never opens a window itself', () => {
  const tokens = messageFrameSandbox.split(' ')
  assert.ok(!tokens.includes('allow-scripts'))
  assert.ok(!tokens.includes('allow-popups'))
  assert.ok(!tokens.includes('allow-popups-to-escape-sandbox'))
})

describe('loadsRemotely', () => {
  it('flags a url(), image() or image-set() in any case', () => {
    for (const css of [
      'background: url(https://tracker.example/p.gif)',
      'background: URL("https://tracker.example/p.gif")',
      'background-image: Image(https://tracker.example/p.gif)',
      'background: image-set("a.png" 1x)',
      'background: -webkit-image-set(url(a.png) 1x)',
    ]) {
      assert.equal(loadsRemotely(css), true, css)
    }
  })

  it('reads through comments the way CSS does', () => {
    assert.equal(loadsRemotely('background: url/**/(https://tracker.example/p.gif)'), true)
    assert.equal(loadsRemotely('background: U/**/RL(https://tracker.example/p.gif)'), true)
  })

  it('reads escaped spellings of the function name', () => {
    assert.equal(loadsRemotely(String.raw`background: \75 rl(https://tracker.example/p.gif)`), true)
    assert.equal(loadsRemotely(String.raw`background: u\72l(https://tracker.example/p.gif)`), true)
    assert.equal(loadsRemotely(String.raw`background: \000075rl(https://tracker.example/p.gif)`), true)
    assert.equal(loadsRemotely(String.raw`background: \75rl\28 https://tracker.example/p.gif\29`), true)
  })

  it('does not take an escaped slash for the start of a comment', () => {
    assert.equal(loadsRemotely(String.raw`\/* ; background: url(https://tracker.example/p.gif) ; */`), true)
  })

  it('does not take a comment start inside a string for a comment', () => {
    assert.equal(loadsRemotely('content: "/*"; background: url(https://tracker.example/p.gif); content: "*/"'), true)
  })

  it('ignores a url() that only sits inside a comment', () => {
    assert.equal(loadsRemotely('color: red; /* background: url(https://tracker.example/p.gif) */'), false)
    assert.equal(loadsRemotely('color: red /* background: url(https://tracker.example/p.gif)'), false)
  })

  it('flags an @import, which fetches a stylesheet', () => {
    assert.equal(loadsRemotely('@import "https://tracker.example/x.css"'), true)
    assert.equal(loadsRemotely(String.raw`@\69mport "https://tracker.example/x.css"`), true)
  })

  it('lets ordinary styles through', () => {
    for (const css of ['color: #1a1a1a; font-weight: 700', 'background: #fff', 'margin: 0 auto; padding: 8px 12px', 'background-image: none']) {
      assert.equal(loadsRemotely(css), false, css)
    }
  })
})

describe('localSvgRef', () => {
  it('keeps a fragment in this document and an inline image', () => {
    for (const value of ['#glyph', ' #glyph', 'data:image/png;base64,iVBORw0KGgo=', 'DATA:IMAGE/svg+xml,<svg/>']) {
      assert.equal(localSvgRef(value), true, value)
    }
  })

  it('refuses anything the browser would fetch or run', () => {
    for (const value of [
      'https://tracker.example/x.svg#a',
      'HTTP://tracker.example/x.svg',
      '//tracker.example/x.svg#a',
      'ht\ttps://tracker.example/x.svg',
      'data:text/html,<script>x</script>',
      'javascript:alert(1)',
      'x.svg#a',
    ]) {
      assert.equal(localSvgRef(value), false, value)
    }
  })
})
