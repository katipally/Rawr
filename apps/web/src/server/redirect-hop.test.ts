import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeHtml, hopHref, hopPage, hopResponse } from './redirect-hop.ts'

test('only absolute http and https addresses can be hopped to', () => {
  assert.equal(hopHref('https://client.example/cb?code=a b'), 'https://client.example/cb?code=a%20b')
  assert.equal(hopHref(new URL('http://127.0.0.1:8123/cb')), 'http://127.0.0.1:8123/cb')
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'vbscript:x', '/thanks', 'thanks', '', '//evil.example']) {
    assert.equal(hopHref(bad), null, bad)
  }
})

test('escapeHtml neutralises every character that can leave an attribute or a tag', () => {
  assert.equal(escapeHtml(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&#39;f')
  assert.equal(escapeHtml('plain'), 'plain')
})

test('an address that tries to break out of its attribute is emitted escaped everywhere', () => {
  const html = hopPage('https://client.example/cb?x="><script>alert(1)</script>&y=\'z')
  assert.ok(!html.includes('<script'))
  assert.ok(!html.includes('"><'))
  assert.equal(html.match(/&quot;&gt;&lt;script&gt;/g)?.length, 2)
  assert.equal(html.match(/<meta http-equiv="refresh" content="0;url=[^"]*">/g)?.length, 1)
  assert.equal(html.match(/<a href="[^"]*">continue<\/a>/g)?.length, 1)
})

test('the page names the destination host and carries a visible link', () => {
  const html = hopPage('https://client.example:8443/cb?code=1&state=2')
  assert.ok(html.includes('<strong>client.example:8443</strong>'))
  assert.ok(html.includes('content="0;url=https://client.example:8443/cb?code=1&amp;state=2"'))
  assert.ok(html.includes('<a href="https://client.example:8443/cb?code=1&amp;state=2">continue</a>'))
})

test('the response is a 200 html page that is never cached', async () => {
  const response = hopResponse(new URL('http://127.0.0.1:8123/cb?code=1'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.ok((await response.text()).includes('http://127.0.0.1:8123/cb?code=1'))
})

test('a scheme that is not http or https is refused rather than rendered', () => {
  assert.throws(() => hopResponse('javascript:alert(1)'), /http or https/)
})
