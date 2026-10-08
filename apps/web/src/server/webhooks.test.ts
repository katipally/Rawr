import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, test } from 'node:test'
import { deliverWebhook, type WebhookJob } from './webhook-delivery.ts'

/** Loopback only, reached over http with RAWR_DEV_OUTBOUND=1 outside production.
 *  Each test sets its own mode, so none depends on what ran before it. */

const vars = process.env as Record<string, string | undefined>
const original = { NODE_ENV: vars.NODE_ENV, RAWR_DEV_OUTBOUND: vars.RAWR_DEV_OUTBOUND }
const servers: Server[] = []

afterEach(() => {
  vars.NODE_ENV = original.NODE_ENV
  vars.RAWR_DEV_OUTBOUND = original.RAWR_DEV_OUTBOUND
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    server.close()
  }
})

const receiver = async (status: number, body = '', headers: Record<string, string> = {}) => {
  const server = createServer((_req, res) => {
    res.writeHead(status, headers)
    res.end(body)
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`
}

const job = (url: string): WebhookJob => ({
  accountId: randomUUID(),
  endpointId: randomUUID(),
  url,
  secret: 'test-secret',
  event: 'contact.created',
  body: '{"event":"contact.created"}',
})

const devMode = () => {
  vars.NODE_ENV = 'development'
  vars.RAWR_DEV_OUTBOUND = '1'
}

test('a 2xx answer is a delivery', async () => {
  devMode()
  assert.deepEqual(await deliverWebhook(job(await receiver(204))), { ok: true })
})

test('a receiver that answers with a large body is still a delivery', async () => {
  devMode()
  assert.deepEqual(await deliverWebhook(job(await receiver(200, 'x'.repeat(200_000)))), { ok: true })
})

test('a non-2xx answer fails with the status in one plain sentence', async () => {
  devMode()
  const url = await receiver(405, 'Method Not Allowed')
  const outcome = await deliverWebhook(job(url))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.reason, `${new URL(url).host} answered 405.`)
})

test('a redirect is named as one, because Rawr does not follow it', async () => {
  devMode()
  const outcome = await deliverWebhook(job(await receiver(301, '', { location: 'https://elsewhere.example.test/' })))
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.reason : '', /answered 301 with a redirect, which Rawr does not follow\.$/)
})

test('an address on a private network is refused with the reason, not a transport error', async () => {
  vars.NODE_ENV = 'production'
  vars.RAWR_DEV_OUTBOUND = undefined
  const outcome = await deliverWebhook(job('https://127.0.0.1/hook'))
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.reason : '', /is on a private network\./)
})

test('a receiver that is not listening fails with a readable sentence and no stack', async () => {
  devMode()
  const probe = createServer()
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((done) => probe.close(() => done()))
  const outcome = await deliverWebhook(job(`http://127.0.0.1:${port}/hook`))
  assert.equal(outcome.ok, false)
  const reason = outcome.ok === false ? outcome.reason : ''
  assert.match(reason, /^127\.0\.0\.1:\d+ refused the connection\.$/)
  assert.doesNotMatch(reason, /\n|at \w+ \(|\.ts:\d+/)
})
