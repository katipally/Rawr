import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { insertEvent, type EventDraft } from './calendar.ts'

const draft: EventDraft = {
  userId: 'host-1',
  summary: 'Intro call',
  description: '',
  startsAt: new Date('2026-11-02T17:00:00Z'),
  endsAt: new Date('2026-11-02T17:30:00Z'),
  timezone: 'America/Los_Angeles',
  attendee: { name: 'Priya', email: 'priya@acme.test' },
  requestConference: true,
  location: null,
}

const calendar = (...answers: object[]) => {
  const requests: { url: URL; method: string; body: Record<string, unknown> | null }[] = []
  mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => {
    requests.push({
      url: new URL(String(url)),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)]
    return new Response(JSON.stringify(answer), { status: 200 })
  })
  return requests
}

test('a Meet room is asked for by name, with the version that makes Google act on it', async () => {
  const requests = calendar({ id: 'ev1', hangoutLink: 'https://meet.google.com/abc-defg-hij' })
  const written = await insertEvent('token', 'primary', draft)

  const sent = requests[0]!
  assert.equal(sent.url.searchParams.get('conferenceDataVersion'), '1')
  const createRequest = (sent.body!.conferenceData as { createRequest: Record<string, unknown> }).createRequest
  assert.deepEqual(createRequest.conferenceSolutionKey, { type: 'hangoutsMeet' })
  assert.match(String(createRequest.requestId), /^rawr-host-1-/)
  assert.equal(written.conferenceUrl, 'https://meet.google.com/abc-defg-hij')
  mock.restoreAll()
})

test('a conference still pending when the insert returns is read again until it has a link', async () => {
  const requests = calendar(
    { id: 'ev1', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } },
    {
      id: 'ev1',
      conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/xyz' }] },
    },
  )
  const written = await insertEvent('token', 'primary', draft)
  assert.equal(written.conferenceUrl, 'https://meet.google.com/xyz')
  assert.equal(requests.length, 2)
  assert.equal(requests[1]?.method, 'GET')
  assert.equal(requests[1]?.url.searchParams.get('conferenceDataVersion'), '1')
  mock.restoreAll()
})

test('an event that did not ask for a room sends no conference data and reads nothing back', async () => {
  const requests = calendar({ id: 'ev2' })
  const written = await insertEvent('token', 'primary', { ...draft, requestConference: false })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.body?.conferenceData, undefined)
  assert.equal(requests[0]?.url.searchParams.has('conferenceDataVersion'), false)
  assert.equal(written.conferenceUrl, null)
  mock.restoreAll()
})
