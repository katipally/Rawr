import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sanitiseHtml } from './mail-html.ts'

/** Every spelling a browser would read as a javascript: or vbscript: link. Each one
 *  must lose its href; the words inside the link must stay. */
const executableHrefs = [
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="java\nscript:alert(1)">x</a>',
  '<a href=javascript:alert(1)>x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74:alert(1)">x</a>',
  '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="&Tab;javascript:alert(1)">x</a>',
  '<a href="   javascript:alert(1)">x</a>',
  '<a href="\u0001javascript:alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<a href="javascript:alert(1)" href="https://ok.example">x</a>',
]

for (const html of executableHrefs) {
  test(`a link that runs code is defused, not kept: ${html}`, () => {
    const cleaned = sanitiseHtml(html)
    assert.equal(/href|javascript|vbscript|data:/i.test(cleaned), false, cleaned)
    assert.equal(cleaned.includes('x'), true)
  })
}

test('a link written with a tab inside the scheme is judged on the joined URL', () => {
  assert.equal(sanitiseHtml('<a href="ht&#9;tps://ok.example/">x</a>'), '<a href="https://ok.example/">x</a>')
})

test('a same-page anchor, mailto and https link survive as written', () => {
  for (const href of ['#top', 'mailto:trevor@datasaur.ai', 'https://ok.example/a?b=1']) {
    const html = `<a href="${href}">x</a>`
    assert.equal(sanitiseHtml(html), html)
  }
})

test('script, style, iframe, object and embed go whole, with their contents', () => {
  const cleaned = sanitiseHtml(
    '<p>Hi</p><script>steal()</script><style>body{}</style><iframe srcdoc="<b>x</b>"></iframe><object data="y"></object><embed src="z">',
  )
  assert.equal(cleaned, '<p>Hi</p>')
})

test('a stray title, noscript or template is not shown as text', () => {
  assert.equal(sanitiseHtml('<title>Newsletter</title><p>Hi</p>'), '<p>Hi</p>')
  assert.equal(sanitiseHtml('<noscript><img src="https://t.example/p.gif"></noscript><p>Hi</p>'), '<p>Hi</p>')
  assert.equal(sanitiseHtml('<template><img src="https://t.example/p.gif"></template><p>Hi</p>'), '<p>Hi</p>')
})

test('svg and math are removed whole, including links inside them', () => {
  const cleaned = sanitiseHtml('<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg><math><mi>y</mi></math><p>z</p>')
  assert.equal(cleaned, '<p>z</p>')
})

test('forms and inputs are removed, because a form in mail is a way to ask for a password', () => {
  const cleaned = sanitiseHtml('<form action="https://evil.example"><input name="pw"><button>Go</button></form><p>Hi</p>')
  assert.equal(cleaned, '<p>Hi</p>')
})

test('event handlers are removed however they are quoted or spelled', () => {
  const cleaned = sanitiseHtml(
    `<a href="#" onclick="x()" onmouseover='y()' onfocus=z() ONLOAD=w()>Hi</a><img src="https://t.example/p.gif" onerror="x()">`,
  )
  assert.equal(/on[a-z]+=/i.test(cleaned), false)
  assert.equal(cleaned.includes('href="#"'), true)
})

test('a data: image cannot smuggle a document in, and a remote image is kept for the reader to load', () => {
  assert.equal(sanitiseHtml('<img src="data:text/html,<script>x</script>">').includes('data:'), false)
  assert.equal(sanitiseHtml('<img src="https://t.example/p.gif" alt="logo">'), '<img src="https://t.example/p.gif" alt="logo">')
})

test('srcset is removed, so an image cannot load from a second list the reader never sees', () => {
  assert.equal(sanitiseHtml('<img src="https://a.example/1.png" srcset="https://b.example/2.png 2x">'), '<img src="https://a.example/1.png">')
})

test('a CSS url() is removed, however it is spelled', () => {
  for (const style of [
    'background:url(https://t.example/p.gif)',
    'background:URL( https://t.example/p.gif )',
    'background:u\\72l(https://t.example/p.gif)',
    'background:url&#40;https://t.example/p.gif)',
    'background-image:image-set("https://t.example/p.gif" 1x)',
    'background:-webkit-cross-fade(url(https://t.example/a.gif), url(https://t.example/b.gif), 0.5)',
    '@import "https://t.example/x.css"',
    'width:expression(alert(1))',
    'behavior:url(x.htc)',
  ]) {
    const cleaned = sanitiseHtml(`<div style="${style.replace(/"/g, '&quot;')}">x</div>`)
    assert.equal(cleaned, '<div>x</div>', style)
  }
})

test('an ordinary inline style survives', () => {
  assert.equal(sanitiseHtml('<p style="color:#333;font-size:14px">x</p>'), '<p style="color:#333;font-size:14px">x</p>')
})

test('a table or cell background is kept only as an http(s) URL, for the reader to gate', () => {
  assert.equal(
    sanitiseHtml('<table background="https://t.example/bg.gif"><tbody><tr><td background="https://t.example/c.gif">x</td></tr></tbody></table>'),
    '<table background="https://t.example/bg.gif"><tbody><tr><td background="https://t.example/c.gif">x</td></tr></tbody></table>',
  )
  assert.equal(sanitiseHtml('<table background="javascript:alert(1)"><tbody><tr><td>x</td></tr></tbody></table>').includes('background'), false)
})

test('body background is dropped with the body tag', () => {
  assert.equal(sanitiseHtml('<body background="https://t.example/bg.gif"><p>x</p></body>'), '<p>x</p>')
})

test('a video poster is kept for the reader to gate, and no video source is', () => {
  assert.equal(
    sanitiseHtml('<video poster="https://t.example/p.jpg" src="https://t.example/v.mp4" controls=""><source src="https://t.example/v.webm"></video>'),
    '<video poster="https://t.example/p.jpg"></video>',
  )
  assert.equal(sanitiseHtml('<video poster="javascript:alert(1)"></video>'), '<video></video>')
})

test('a link element and a style block in the head are removed', () => {
  assert.equal(sanitiseHtml('<link rel="stylesheet" href="https://t.example/x.css"><p>x</p>'), '<p>x</p>')
})

test('comments are removed', () => {
  assert.equal(sanitiseHtml('<p>a</p><!-- hidden --><p>b</p>'), '<p>a</p><p>b</p>')
})

test('ordinary mail formatting round-trips unchanged', () => {
  for (const html of [
    '<p>Hi <b>there</b> <i>friend</i></p>',
    '<blockquote>quoted</blockquote>',
    '<ul><li>one</li><li>two</li></ul>',
    '<ol start="3" type="a"><li value="5">five</li></ol>',
    '<table width="100%" cellpadding="0"><tbody><tr><td align="center" valign="top" bgcolor="#fff">cell</td></tr></tbody></table>',
    '<font color="red" face="Arial" size="2">big</font><br><hr>',
    '<h2>Title</h2><pre>code</pre><center>middle</center>',
    '<img src="https://t.example/p.gif" alt="logo" width="120" height="40">',
  ]) {
    assert.equal(sanitiseHtml(html), html)
  }
})

test('an unknown wrapper is unwrapped and its contents kept', () => {
  assert.equal(sanitiseHtml('<section class="x"><p>keep</p></section>'), '<p>keep</p>')
})

test('sanitising twice gives the same output as once', () => {
  const once = sanitiseHtml('<p onclick="x()">Hi <a href="java&#x09;script:1">link</a><img src="https://t.example/p.gif"></p>')
  assert.equal(sanitiseHtml(once), once)
})

test('an empty body is an empty string', () => {
  assert.equal(sanitiseHtml(''), '')
})

test('nesting past the depth limit is cut, not allowed to overflow the stack', () => {
  const cleaned = sanitiseHtml(`${'<div>'.repeat(5000)}deep${'</div>'.repeat(5000)}`)
  assert.equal(cleaned.split('<div>').length - 1, 500)
  assert.equal(cleaned.includes('deep'), false)
})

test('a long run of unknown wrappers is unwrapped without depth cost, and keeps its order', () => {
  const wrapped = `${'<x-wrap>'.repeat(3000)}<p>a</p><script>no</script><p>b</p>${'</x-wrap>'.repeat(3000)}`
  assert.equal(sanitiseHtml(wrapped), '<p>a</p><p>b</p>')
})

test('a dropped element inside an unknown wrapper is still dropped', () => {
  assert.equal(sanitiseHtml('<section><script>x()</script><p>keep</p></section>'), '<p>keep</p>')
})
