import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deviceLabel } from './device.ts'

test('names the browser and the system it ran on', () => {
  assert.equal(
    deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'),
    'Chrome on macOS',
  )
  assert.equal(
    deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'),
    'Edge on Windows',
  )
  assert.equal(
    deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'),
    'Safari on iPhone',
  )
  assert.equal(
    deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'),
    'Chrome on Android',
  )
  assert.equal(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0'), 'Firefox on Linux')
})

test('a browser the list does not know is still named, and so is a missing one', () => {
  assert.equal(deviceLabel('SomeBrowser/1.0'), 'Browser')
  assert.equal(deviceLabel('   '), 'Unknown device')
  assert.equal(deviceLabel(null), 'Unknown device')
})
