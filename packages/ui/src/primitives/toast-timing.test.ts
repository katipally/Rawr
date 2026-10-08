import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACTION_TOAST_MS,
  READ_MS_PER_CHAR,
  READ_TOAST_MAX_MS,
  READ_TOAST_MIN_MS,
  SHORT_TOAST_MS,
  toastLifetime,
} from './toast-timing.ts'

const plain = (tone: 'success' | 'error' | 'info', message: string) => toastLifetime({ tone, message, hasAction: false })

test('success and info keep the short timer whatever the length', () => {
  assert.equal(plain('success', 'Saved.'), SHORT_TOAST_MS)
  assert.equal(plain('info', 'x'.repeat(500)), SHORT_TOAST_MS)
})

test('an error gets the floor when its message is short', () => {
  assert.equal(plain('error', ''), READ_TOAST_MIN_MS)
  assert.equal(plain('error', 'Could not save.'), READ_TOAST_MIN_MS)
})

test('an error grows with its message between the floor and the cap', () => {
  const chars = 150
  assert.equal(plain('error', 'x'.repeat(chars)), chars * READ_MS_PER_CHAR)
  assert.equal(plain('error', 'x'.repeat(10_000)), READ_TOAST_MAX_MS)
})

test('a toast with an action stays for its action window', () => {
  assert.equal(toastLifetime({ tone: 'success', message: 'Deleted.', hasAction: true }), ACTION_TOAST_MS)
  assert.equal(toastLifetime({ tone: 'error', message: 'Failed.', hasAction: true }), ACTION_TOAST_MS)
})

test('an error with an action keeps the longer of its action window and its reading time', () => {
  assert.equal(toastLifetime({ tone: 'error', message: 'x'.repeat(240), hasAction: true }), 240 * READ_MS_PER_CHAR)
  assert.equal(toastLifetime({ tone: 'error', message: 'x'.repeat(10_000), hasAction: true }), READ_TOAST_MAX_MS)
})
