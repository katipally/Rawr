import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')
const { decryptToken, encryptToken, openSecret, sealSecret } = await import('./crypto.ts')

test('a sealed secret opens to what was sealed, and is not the secret', () => {
  const sealed = sealSecret('whsec_abc123')
  assert.notEqual(sealed, 'whsec_abc123')
  assert.ok(sealed.startsWith('v1.'))
  assert.equal(openSecret(sealed), 'whsec_abc123')
})

test('sealing twice does not wrap the value again', () => {
  const sealed = sealSecret('whsec_abc123')
  assert.equal(sealSecret(sealed), sealed)
})

test('a row written before sealing is plaintext and still opens to itself', () => {
  assert.equal(openSecret('whsec_legacy'), 'whsec_legacy')
  assert.equal(openSecret('shh'), 'shh')
})

test('an empty secret stays empty, so a missing one is still missing', () => {
  assert.equal(sealSecret(''), '')
})

test('a secret that merely starts with v1. is sealed rather than mistaken for ciphertext', () => {
  const sealed = sealSecret('v1.not-sealed')
  assert.ok(sealed.startsWith('v1.'))
  assert.equal(openSecret(sealed), 'v1.not-sealed')
})

test('a tampered sealed value fails loudly instead of signing with garbage', () => {
  const sealed = encryptToken('whsec_abc123')
  const parts = sealed.split('.')
  parts[3] = `${parts[3]?.slice(0, -2)}AA`
  assert.throws(() => openSecret(parts.join('.')))
  assert.equal(decryptToken(sealed), 'whsec_abc123')
})
