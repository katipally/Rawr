import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { checkOutboundUrl, devOutbound, refusedAddress } from './outbound-policy.ts'

const env = { NODE_ENV: process.env.NODE_ENV, RAWR_DEV_OUTBOUND: process.env.RAWR_DEV_OUTBOUND }
const mode = (nodeEnv: string | undefined, dev: '1' | undefined) => {
  if (nodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = nodeEnv
  if (dev === undefined) delete process.env.RAWR_DEV_OUTBOUND
  else process.env.RAWR_DEV_OUTBOUND = dev
}
afterEach(() => mode(env.NODE_ENV, env.RAWR_DEV_OUTBOUND as '1' | undefined))

test('public addresses are allowed, including a public one wrapped in IPv6', () => {
  for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:93.184.216.34']) {
    assert.equal(refusedAddress(address), false, address)
  }
})

test('every inside range is refused, mapped IPv6 and zone ids included', () => {
  for (const address of [
    '0.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '172.31.0.1', '192.0.0.8', '192.168.0.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::', 'fc00::1', 'fd12::1',
    'fe80::1', 'fe80::1%eth0', 'ff02::1', 'not an address',
  ]) {
    assert.equal(refusedAddress(address), true, address)
  }
})

test('the development flag lifts loopback only, and never in production', () => {
  mode('development', '1')
  assert.equal(devOutbound(), true)
  assert.equal(refusedAddress('127.0.0.1'), false)
  assert.equal(refusedAddress('::1'), false)
  assert.equal(refusedAddress('::ffff:127.0.0.1'), false)
  for (const address of ['10.0.0.1', '169.254.169.254', '192.168.0.1', 'fd00::1', '0.0.0.0']) {
    assert.equal(refusedAddress(address), true, address)
  }
  mode('production', '1')
  assert.equal(devOutbound(), false)
  assert.equal(refusedAddress('127.0.0.1'), true)
  mode('development', undefined)
  assert.equal(devOutbound(), false)
  assert.equal(refusedAddress('127.0.0.1'), true)
})

test('a URL is checked as written', () => {
  mode('production', undefined)
  assert.equal(checkOutboundUrl(' https://example.com/hooks?a=1 '), 'https://example.com/hooks?a=1')
  for (const url of ['http://example.com/', 'ftp://example.com/', 'javascript:alert(1)']) {
    assert.throws(() => checkOutboundUrl(url), /has to be https/, url)
  }
  for (const url of [
    'https://localhost/', 'https://LOCALHOST./', 'https://a.localhost/', 'https://printer.local/', 'https://x.internal/',
    'https://127.0.0.1/', 'https://127.1/', 'https://2130706433/', 'https://[::1]/', 'https://[::ffff:7f00:1]/',
    'https://169.254.169.254/', 'https://10.0.0.1:8443/',
  ]) {
    assert.throws(() => checkOutboundUrl(url), /private network/, url)
  }
  assert.throws(() => checkOutboundUrl('not a url'), /is not a URL/)
})

test('in development with the flag, localhost over http passes and the metadata address still does not', () => {
  mode('development', '1')
  assert.equal(checkOutboundUrl('http://localhost:4599/hook'), 'http://localhost:4599/hook')
  assert.equal(checkOutboundUrl('http://127.0.0.1:4599/hook'), 'http://127.0.0.1:4599/hook')
  assert.throws(() => checkOutboundUrl('http://169.254.169.254/'), /private network/)
  assert.throws(() => checkOutboundUrl('https://x.internal/'), /private network/)
})
