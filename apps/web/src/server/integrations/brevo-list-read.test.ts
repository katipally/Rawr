import assert from 'node:assert/strict'
import { beforeEach, describe, it, mock } from 'node:test'
import type { AccountContext } from '@rawr/db'

/** Database calls are replaced. The Brevo read is a page view, so the test also
 *  checks that it writes no health row. */
const writes: string[] = []
let credentials: { secret: string; config: Record<string, unknown>; id: string } | null = null
const unused = async () => {
  throw new Error('not used by the list size read')
}

mock.module('@rawr/db', {
  namedExports: {
    assertCanWrite: unused,
    checkOutboundUrl: unused,
    refusedAddress: unused,
    getRecord: unused,
    ingestMarketingEvent: unused,
    listSubscriptionTypes: unused,
    once: unused,
    readSegmentContactPage: unused,
    readWholeConfig: unused,
    recordDeadLetter: unused,
    recordOutboundCall: unused,
    readCredentials: async () => credentials,
    recordHealth: async () => {
      writes.push('health')
    },
  },
})

const { readBrevoListSize } = await import('./brevo.ts')

const ctx: AccountContext = {
  accountId: '00000000-0000-4000-8000-000000000000',
  actorId: null,
  actorKind: 'user',
  isSuperAdmin: true,
  viewHubs: [],
  editHubs: [],
}

let requests: { url: string; apiKey: string | null }[] = []
let answer: () => Promise<Response> = async () => new Response('{}', { status: 200 })

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  requests.push({ url: String(input), apiKey: headers.get('api-key') })
  return answer()
}) as typeof fetch

beforeEach(() => {
  writes.length = 0
  requests = []
  credentials = { secret: 'xkeysib-test', config: {}, id: '00000000-0000-4000-8000-000000000009' }
  answer = async () =>
    new Response(JSON.stringify({ id: 12, name: 'Newsletter', totalSubscribers: 1834, totalBlacklisted: 56 }), { status: 200 })
})

describe('readBrevoListSize', () => {
  it('reads one list from Brevo and returns its counts, with no health write', async () => {
    assert.deepEqual(await readBrevoListSize(ctx, '12'), { subscribers: 1834, blacklisted: 56 })
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.url, 'https://api.brevo.com/v3/contacts/lists/12')
    assert.equal(requests[0]!.apiKey, 'xkeysib-test')
    assert.deepEqual(writes, [])
  })

  it('treats missing counts as zero rather than as an error', async () => {
    answer = async () => new Response(JSON.stringify({ id: 12, name: 'Newsletter' }), { status: 200 })
    assert.deepEqual(await readBrevoListSize(ctx, '12'), { subscribers: 0, blacklisted: 0 })
  })

  it('returns null, and sends nothing, when Brevo is not connected', async () => {
    credentials = null
    assert.equal(await readBrevoListSize(ctx, '12'), null)
    assert.equal(requests.length, 0)
  })

  it('returns null when Brevo is unreachable', async () => {
    answer = async () => {
      throw new TypeError('fetch failed')
    }
    assert.equal(await readBrevoListSize(ctx, '12'), null)
    assert.deepEqual(writes, [])
  })

  it('returns null when Brevo refuses the key or does not know the list', async () => {
    answer = async () => new Response('{"code":"not_found","message":"List ID not found"}', { status: 404 })
    assert.equal(await readBrevoListSize(ctx, '12'), null)
    answer = async () => new Response('{"code":"unauthorized"}', { status: 401 })
    assert.equal(await readBrevoListSize(ctx, '12'), null)
  })

  it('sends nothing for a list id that is blank, zero or not a whole number', async () => {
    for (const listId of ['', '0', '-3', '1.5', 'abc']) {
      assert.equal(await readBrevoListSize(ctx, listId), null, listId)
    }
    assert.equal(requests.length, 0)
  })
})
