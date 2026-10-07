import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, test } from 'node:test'
import { hostOf, outboundRequest } from './outbound.ts'

/** Only loopback is ever connected to here. A name is pointed at it through the
 *  injected resolver, which is how a name that resolves somewhere is simulated
 *  without touching DNS. */

const vars = process.env as Record<string, string | undefined>
const env = { NODE_ENV: vars.NODE_ENV, RAWR_DEV_OUTBOUND: vars.RAWR_DEV_OUTBOUND }
const set = (name: string, value: string | undefined) => {
  if (value === undefined) delete vars[name]
  else vars[name] = value
}
const mode = (nodeEnv: string | undefined, dev: '1' | undefined) => {
  set('NODE_ENV', nodeEnv)
  set('RAWR_DEV_OUTBOUND', dev)
}
const servers: Server[] = []
afterEach(() => {
  mode(env.NODE_ENV, env.RAWR_DEV_OUTBOUND as '1' | undefined)
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    server.close()
  }
})

const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return (server.address() as AddressInfo).port
}

const call = (url: string, resolve?: Parameters<typeof outboundRequest>[1], over = {}) =>
  outboundRequest({ url, method: 'POST', body: '{}', timeoutMs: 2_000, maxBytes: 1_024, ...over }, resolve)

const to = (...addresses: string[]) => async () =>
  addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

test('every private, loopback, link-local, CGNAT, multicast and metadata literal is refused', async () => {
  mode('production', undefined)
  const inside = [
    'https://127.0.0.1/',
    'https://10.0.0.5/',
    'https://172.16.0.1/',
    'https://172.31.255.255/',
    'https://192.168.1.1/',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/',
    'https://0.0.0.0/',
    'https://224.0.0.1/',
    'https://255.255.255.255/',
    'https://2130706433/',
    'https://0x7f.1/',
    'https://localhost/',
    'https://db.internal/',
    'https://[::1]/',
    'https://[::]/',
    'https://[fd00::1]/',
    'https://[fe80::1]/',
    'https://[ff02::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:7f00:1]/',
    'https://[::ffff:169.254.169.254]/',
    'https://[64:ff9b::7f00:1]/',
    'https://[2002:7f00:1::]/',
  ]
  for (const url of inside) {
    await assert.rejects(call(url, to('93.184.216.34')), /private network/, url)
  }
})

test('a name that resolves inside is refused whatever it is called', async () => {
  mode('production', undefined)
  for (const answer of [['127.0.0.1'], ['169.254.169.254'], ['10.1.2.3'], ['::1'], ['::ffff:10.0.0.1'], ['fd00::5']]) {
    await assert.rejects(call('https://hooks.example.test/x', to(...answer)), /resolves to a private address/, answer.join())
  }
})

test('one private record among public ones refuses the name', async () => {
  mode('production', undefined)
  await assert.rejects(
    call('https://mixed.example.test/', to('93.184.216.34', '10.0.0.9')),
    /resolves to a private address/,
  )
})

test('a name is judged every time it is connected to, so a rebind after a clean first answer is caught', async () => {
  mode('production', undefined)
  const answers = [['192.0.2.1'], ['127.0.0.1']]
  const resolve = async () => to(...(answers.shift() ?? ['127.0.0.1']))()
  // 192.0.2.1 is documentation space: allowed, never routed, so this only ever
  // times out or fails to reach it. What matters is that it is not refused.
  const first = await call('https://rebind.example.test/', resolve, { timeoutMs: 300 }).catch((error: Error) => error)
  assert.ok(first instanceof Error)
  assert.doesNotMatch(first.message, /private address/)
  await assert.rejects(call('https://rebind.example.test/', resolve), /resolves to a private address/)
})

test('http is refused in production even with the development flag set', async () => {
  mode('production', '1')
  await assert.rejects(call('http://127.0.0.1:9/'), /has to be https/)
  await assert.rejects(call('https://127.0.0.1/'), /private network/)
})

test('the development flag allows loopback over http, and nothing else inside', async () => {
  mode('development', '1')
  const port = await listen((_req, res) => res.end('ok'))
  const loopback = await call(`http://127.0.0.1:${port}/`)
  assert.equal(loopback.status, 200)
  const named = await call(`http://receiver.example.test:${port}/`, to('127.0.0.1'))
  assert.equal(named.ok, true)
  await assert.rejects(call('http://169.254.169.254/'), /private network/)
  await assert.rejects(call('http://192.168.1.1/'), /private network/)
  await assert.rejects(call('http://10.0.0.1/'), /private network/)
})

test('without the flag, loopback is refused outside production too', async () => {
  mode('development', undefined)
  await assert.rejects(call('http://127.0.0.1:9/'), /has to be https/)
  await assert.rejects(call('https://127.0.0.1:9/'), /private network/)
})

test('a redirect is read as an answer and never followed', async () => {
  mode('development', '1')
  let reached = 0
  const target = await listen((_req, res) => {
    reached += 1
    res.end('secret')
  })
  const port = await listen((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target}/internal` })
    res.end()
  })
  const response = await call(`http://127.0.0.1:${port}/`)
  assert.equal(response.status, 302)
  assert.equal(response.ok, false)
  assert.equal(reached, 0)
})

test('a redirect to a private address is not followed either', async () => {
  mode('development', '1')
  const port = await listen((_req, res) => {
    res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data' })
    res.end()
  })
  const response = await call(`http://127.0.0.1:${port}/`)
  assert.equal(response.status, 307)
  assert.equal(response.ok, false)
})

test('a huge answer is cut at the cap and the connection dropped', async () => {
  mode('development', '1')
  const port = await listen((_req, res) => {
    res.writeHead(200)
    const push = () => {
      while (res.write(Buffer.alloc(64 * 1024, 97))) continue
      res.once('drain', push)
    }
    push()
  })
  const response = await call(`http://127.0.0.1:${port}/`, undefined, { maxBytes: 1_024 })
  assert.equal(response.status, 200)
  assert.equal(response.truncated, true)
  assert.equal(response.text.length, 1_024)
})

test('an answer exactly at the cap is not truncated', async () => {
  mode('development', '1')
  const port = await listen((_req, res) => res.end('a'.repeat(1_024)))
  const response = await call(`http://127.0.0.1:${port}/`, undefined, { maxBytes: 1_024 })
  assert.equal(response.truncated, false)
  assert.equal(response.text.length, 1_024)
})

test('a receiver that never answers is cut off at the deadline', async () => {
  mode('development', '1')
  const port = await listen(() => {})
  const started = Date.now()
  await assert.rejects(call(`http://127.0.0.1:${port}/`, undefined, { timeoutMs: 300 }), /did not answer within 1 seconds/)
  assert.ok(Date.now() - started < 1_500)
})

test('a receiver that trickles its body is cut off at the same deadline', async () => {
  mode('development', '1')
  const port = await listen((_req, res) => {
    res.writeHead(200)
    const drip = setInterval(() => res.write('x'), 50)
    res.on('close', () => clearInterval(drip))
  })
  const started = Date.now()
  await assert.rejects(
    call(`http://127.0.0.1:${port}/`, undefined, { timeoutMs: 400, maxBytes: 1_000_000 }),
    /did not answer within/,
  )
  assert.ok(Date.now() - started < 1_500)
})

test('the body, headers and method arrive as given', async () => {
  mode('development', '1')
  let seen = ''
  const port = await listen((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      seen = `${req.method} ${req.url} ${req.headers['x-test']} ${req.headers['content-length']} ${body}`
      res.writeHead(201, { 'retry-after': '7' })
      res.end('done')
    })
  })
  const response = await call(`http://127.0.0.1:${port}/a/b?c=d`, undefined, { headers: { 'x-test': 'yes' }, body: '{"a":1}' })
  assert.equal(seen, 'POST /a/b?c=d yes 7 {"a":1}')
  assert.equal(response.status, 201)
  assert.equal(response.retryAfter, '7')
  assert.equal(response.text, 'done')
})

test('an error names the host and never the path or query', async () => {
  mode('development', '1')
  const message = await call('http://127.0.0.1:9/hooks/abc?token=hunter2').then(
    () => '',
    (error: Error) => error.message,
  )
  assert.match(message, /127\.0\.0\.1:9/)
  assert.doesNotMatch(message, /hunter2|hooks\/abc/)
  assert.equal(hostOf('https://a.example.test/p?q=1'), 'a.example.test')
  assert.equal(hostOf('not a url'), 'that address')
})
