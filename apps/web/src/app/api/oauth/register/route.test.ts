import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NextRequest } from 'next/server'
import { POST } from './route.ts'

/** The route reads only headers and the body, so a plain Request stands in for NextRequest. */
const registration = (body: unknown) =>
  new Request('http://localhost/api/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest

const https = (count: number) => Array.from({ length: count }, (_, i) => `https://client.example/cb${i}`)

test('more redirect URIs than the cap is refused in words, before anything is saved', async () => {
  const answer = await POST(registration({ redirect_uris: https(11) }))
  assert.equal(answer.status, 400)
  const body = (await answer.json()) as { error: string; error_description: string }
  assert.equal(body.error, 'invalid_redirect_uri')
  assert.equal(body.error_description, 'redirect_uris can list at most 10 URLs.')
})

test('a client name longer than 200 characters is refused, not cut short', async () => {
  const answer = await POST(registration({ redirect_uris: https(1), client_name: 'n'.repeat(201) }))
  assert.equal(answer.status, 400)
  const body = (await answer.json()) as { error: string; error_description: string }
  assert.equal(body.error, 'invalid_client_metadata')
  assert.equal(body.error_description, 'client_name can be at most 200 characters.')
})

test('the rate limit answers 429 with Retry-After, and the window is the last thing this file asks', async () => {
  let last: Response | null = null
  for (let i = 0; i < 31; i++) last = await POST(registration({}))
  assert.equal(last?.status, 429)
  assert.equal(last?.headers.get('retry-after'), '60')
  assert.equal(last?.headers.get('access-control-allow-origin'), '*')
})
