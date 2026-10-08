import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { AccountContext } from '@rawr/db'
import { authorisedAddress, authorised, collectHistory, devFetcher, grantedModifying, htmlToText, isTransient, parseAddresses, RevokedError, ScopeShortfall, sendMail, type Fetcher } from './gmail.ts'

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
    asked.push(params?.pageToken as string | undefined)
    if (!params?.pageToken) return { history: added('a', 'b'), nextPageToken: 'p2', historyId: '500' }
    if (params.pageToken === 'p2') return { history: added('b', 'c'), nextPageToken: 'p3', historyId: '510' }
    return { history: added('d'), historyId: '520' }
  }
  assert.deepEqual(await collectHistory(fetcher, '100'), { ids: ['a', 'b', 'c', 'd'], threadIds: [], cursor: '520', more: false })
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
  assert.deepEqual(await collectHistory(fetcher, '100'), { ids: [], threadIds: [], cursor: '700', more: false })
})

test('the mailbox is named by the address Google authorised, not the one hinted at', async () => {
  google(() => fresh, () => ({ status: 200, body: { emailAddress: 'other@elsewhere.test', historyId: '1' } }))
  assert.equal(await authorisedAddress('token'), 'other@elsewhere.test')
  mock.restoreAll()
})

test('a profile Google will not give is an error, never a guessed address', async () => {
  google(() => fresh, () => ({ status: 200, body: {} }))
  await assert.rejects(authorisedAddress('token'))
  mock.restoreAll()
})

const devSend = async (body: object) =>
  (await devFetcher('owner@datasaur.test', 'datasaur.ai')('/messages/send', undefined, {
    method: 'POST',
    body: JSON.stringify(body),
  })) as { id: string; threadId: string }

test('a dev send into an existing thread answers with that thread', async () => {
  assert.equal((await devSend({ raw: 'x', threadId: 'thread-existing' })).threadId, 'thread-existing')
})

test('a dev send with no thread starts a thread named after its own message', async () => {
  const sent = await devSend({ raw: 'x' })
  assert.equal(sent.threadId, sent.id)
})

test('two new dev sends do not share a thread', async () => {
  assert.notEqual((await devSend({ raw: 'a' })).threadId, (await devSend({ raw: 'b' })).threadId)
})

test('a mailbox is granted changes to Gmail only with gmail.modify on its scope list', () => {
  assert.equal(grantedModifying(['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify']), true)
  assert.equal(grantedModifying(['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']), false)
  assert.equal(grantedModifying([]), false)
})

// ------------------------------------------------------------- folders

test('a label change to the Inbox or Trash names its thread, and read state does not', async () => {
  const asked: Record<string, string | string[]> = {}
  const fetcher: Fetcher = async (_, params) => {
    Object.assign(asked, params)
    return {
      history: [
        { id: '1', labelsRemoved: [{ message: { id: 'a', threadId: 'gt-archived' }, labelIds: ['INBOX'] }] },
        { id: '2', labelsAdded: [{ message: { id: 'b', threadId: 'gt-trashed' }, labelIds: ['TRASH'] }] },
        { id: '3', labelsAdded: [{ message: { id: 'c', threadId: 'gt-read' }, labelIds: ['UNREAD'] }] },
      ],
      historyId: '600',
    }
  }
  const result = await collectHistory(fetcher, '100')
  assert.deepEqual(result?.threadIds, ['gt-archived', 'gt-trashed'])
  assert.deepEqual(result?.ids, [])
  assert.deepEqual(asked.historyTypes, ['messageAdded', 'labelAdded', 'labelRemoved'])
})

test('Gmail refusing a change for want of gmail.modify is a scope shortfall, not a withdrawal', async () => {
  const live = { accessToken: 'live', refreshToken: 'refresh', accessTokenExpiresAt: new Date(Date.now() + 3_600_000) }
  google(() => fresh, () => ({ status: 403, body: { error: { message: 'Request had insufficient authentication scopes.', reason: 'insufficientPermissions' } } }))
  const { fetcher } = await authorised(ctx, 'm', live, noStore)
  await assert.rejects(fetcher('/threads/gt-1/trash', undefined, { method: 'POST', body: '{}' }), (cause) => cause instanceof ScopeShortfall)
  mock.restoreAll()
})

test('a dev thread is read as sitting in the Inbox, and a change to it is accepted', async () => {
  const dev = devFetcher('me@example.test', 'example.test')
  assert.deepEqual(await dev('/threads/dev-t1', { format: 'minimal' }), { messages: [{ labelIds: ['INBOX'] }] })
  assert.deepEqual(await dev('/threads/dev-t1/modify', undefined, { method: 'POST', body: '{}' }), {})
})
