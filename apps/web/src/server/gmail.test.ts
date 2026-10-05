import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { AccountContext } from '@rawr/db'
import { authorised, collectHistory, htmlToText, isTransient, parseAddresses, RevokedError, sanitiseHtml, sendMail, type Fetcher } from './gmail.ts'

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

// ------------------------------------------------------------ token handling

type Reply = { status: number; body: unknown; headers?: Record<string, string> }

/** Routes the two hosts this module talks to: the token endpoint and Gmail. */
const google = (token: () => Reply | Error, gmail: (bearer: string, call: number) => Reply | Error) => {
  const calls = { token: 0, gmail: 0 }
  mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => {
    let answer: Reply | Error
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      calls.token += 1
      answer = token()
    } else {
      calls.gmail += 1
      answer = gmail(String(((init as RequestInit).headers as Record<string, string>).authorization), calls.gmail)
    }
    if (answer instanceof Error) throw answer
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: answer.headers ?? {} })
  })
  return calls
}

const expired = { accessToken: 'old', refreshToken: 'refresh', accessTokenExpiresAt: new Date(0) }
const noStore = (async () => {}) as never
const ctx = {} as AccountContext
const fresh: Reply = { status: 200, body: { access_token: 'new', expires_in: 3600 } }

test('a refresh that fails for any reason but invalid_grant is not a revocation', async () => {
  for (const failure of [
    { status: 503, body: { error: 'temporarily_unavailable' } },
    { status: 400, body: { error: 'invalid_client' } },
    new TypeError('fetch failed'),
  ]) {
    google(() => failure, () => ({ status: 200, body: {} }))
    await assert.rejects(authorised(ctx, 'm', expired, noStore), (cause) => !(cause instanceof RevokedError))
    mock.restoreAll()
  }
})

test('invalid_grant on refresh is the one answer that revokes', async () => {
  google(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }), () => ({ status: 200, body: {} }))
  await assert.rejects(authorised(ctx, 'm', expired, noStore), RevokedError)
  mock.restoreAll()
})

test('a token that lapses mid-pass is refreshed once and the call retried', async () => {
  const live = { ...expired, accessTokenExpiresAt: new Date(Date.now() + 3_600_000) }
  const calls = google(
    () => fresh,
    (bearer) => (bearer === 'Bearer new' ? { status: 200, body: { ok: true } } : { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } }),
  )
  const { fetcher } = await authorised(ctx, 'm', live, noStore)
  assert.deepEqual(await fetcher('/profile'), { ok: true })
  assert.equal(calls.token, 1)
  assert.equal(calls.gmail, 2)
  mock.restoreAll()
})

test('a 401 that survives a fresh token is a withdrawal, not a loop', async () => {
  const live = { ...expired, accessTokenExpiresAt: new Date(Date.now() + 3_600_000) }
  const calls = google(() => fresh, () => ({ status: 401, body: {} }))
  const { fetcher } = await authorised(ctx, 'm', live, noStore)
  await assert.rejects(fetcher('/profile'), RevokedError)
  assert.equal(calls.gmail, 2)
  mock.restoreAll()
})

test('a rate limit is waited out and is not a withdrawal', async () => {
  const live = { ...expired, accessTokenExpiresAt: new Date(Date.now() + 3_600_000) }
  const quota = { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }
  const calls = google(
    () => fresh,
    (_, call) =>
      call === 1
        ? { status: 403, body: quota, headers: { 'retry-after': '1' } }
        : { status: 200, body: { ok: true } },
  )
  const { fetcher } = await authorised(ctx, 'm', live, noStore)
  assert.deepEqual(await fetcher('/profile'), { ok: true })
  assert.equal(calls.gmail, 2)
  mock.restoreAll()
})

// ------------------------------------------------------------------- sending

const failure = (status: number | undefined, transient = false) =>
  Object.assign(new Error(`Gmail answered ${status}`), { status, transient })

const mail = { raw: 'cmF3', threadId: null, internetMessageId: '<abc@rawr.test>' }

test('a send that timed out is looked up by its Message-ID, and not sent again if Gmail has it', async () => {
  const seen: string[] = []
  const fetcher: Fetcher = async (path, params) => {
    seen.push(path)
    if (path === '/messages/send') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    assert.equal(params?.q, 'rfc822msgid:<abc@rawr.test>')
    return { messages: [{ id: 'gm-1', threadId: 'gt-1' }] }
  }
  assert.deepEqual(await sendMail(fetcher, mail), { id: 'gm-1', threadId: 'gt-1' })
  assert.deepEqual(seen, ['/messages/send', '/messages'])
})

test('a 5xx with nothing in the mailbox is raised so it can be tried again', async () => {
  const fetcher: Fetcher = async (path) => {
    if (path === '/messages/send') throw failure(503, true)
    return {}
  }
  await assert.rejects(sendMail(fetcher, mail), (cause) => isTransient(cause))
})

test('a refused send was not sent, so nothing is looked up', async () => {
  let calls = 0
  const fetcher: Fetcher = async () => {
    calls += 1
    throw failure(400)
  }
  await assert.rejects(sendMail(fetcher, mail), (cause) => !isTransient(cause))
  assert.equal(calls, 1)
})

test('busy, unreachable and slow are transient; refused and withdrawn are not', () => {
  assert.equal(isTransient(failure(503, true)), true)
  assert.equal(isTransient(Object.assign(new Error('x'), { name: 'TimeoutError' })), true)
  assert.equal(isTransient(new TypeError('fetch failed')), true)
  assert.equal(isTransient(failure(400)), false)
  assert.equal(isTransient(new RevokedError('gone')), false)
})

// ------------------------------------------------------------------- history

const added = (...ids: string[]) => ids.map((id) => ({ id: `rec-${id}`, messagesAdded: [{ message: { id } }] }))

test('every page of history is read, and the cursor is the last response\'s head', async () => {
  const asked: (string | undefined)[] = []
  const fetcher: Fetcher = async (_, params) => {
    asked.push(params?.pageToken)
    if (!params?.pageToken) return { history: added('a', 'b'), nextPageToken: 'p2', historyId: '500' }
    if (params.pageToken === 'p2') return { history: added('b', 'c'), nextPageToken: 'p3', historyId: '510' }
    return { history: added('d'), historyId: '520' }
  }
  assert.deepEqual(await collectHistory(fetcher, '100'), { ids: ['a', 'b', 'c', 'd'], cursor: '520', more: false })
  assert.deepEqual(asked, [undefined, 'p2', 'p3'])
})

test('a pass that hits its page limit keeps the last record it read, not the head', async () => {
  let page = 0
  const fetcher: Fetcher = async () => {
    page += 1
    return { history: added(`m${page}`), nextPageToken: `p${page + 1}`, historyId: '9999' }
  }
  const result = await collectHistory(fetcher, '100')
  assert.equal(result?.more, true)
  assert.equal(result?.cursor, 'rec-m5')
  assert.equal(result?.ids.length, 5)
})

test('an aged-out history id is null, which means list everything again', async () => {
  const fetcher: Fetcher = async () => {
    throw Object.assign(new Error('Gmail answered 404'), { status: 404 })
  }
  assert.equal(await collectHistory(fetcher, '100'), null)
})

test('nothing new keeps the cursor moving to the head', async () => {
  const fetcher: Fetcher = async () => ({ historyId: '700' })
  assert.deepEqual(await collectHistory(fetcher, '100'), { ids: [], cursor: '700', more: false })
})
