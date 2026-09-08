import { createCipheriv, createDecipheriv, createHash, randomBytes, } from 'node:crypto'

/** Encryption for the OAuth tokens Rawr holds on a person's behalf.
 *
 *  The key lives in a secrets store, never in the database it
 *  protects, so a database dump is not a set of live Google credentials. It is read
 *  from the environment on first use rather than at import, because most of the
 *  application never touches a token and must still boot without the key present.
 *
 *  AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 *  than producing plausible garbage that gets sent to Google as a bearer token. */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const VERSION = 'v1'

let cached: Buffer | null = null

/** 32 bytes, base64 or hex. Generate one with
 *    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" */
const key = (): Buffer => {
  if (cached) return cached
  const raw = process.env.TOKEN_ENCRYPTION_KEY ?? ''
  if (!raw) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is not set, so a calendar or mailbox token cannot be stored. It must come from a secrets store, never from the database it protects (open item 9).',
    )
  }
  const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (decoded.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to 32 bytes; this one is ${decoded.length}. Generate one with randomBytes(32).`,
    )
  }
  cached = decoded
  return decoded
}

/** `v1.<iv>.<tag>.<ciphertext>`, each part base64url. The version prefix is what
 *  makes rotating the algorithm later a decode branch rather than a migration. */
export const encryptToken = (plaintext: string): string => {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key(), iv)
  const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    sealed.toString('base64url'),
  ].join('.')
}

export const decryptToken = (value: string): string => {
  const [version, iv, tag, sealed] = value.split('.')
  if (version !== VERSION || !iv || !tag || !sealed) {
    throw new Error('That stored token is not in a format this build can read.')
  }
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(sealed, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/** URL-safe, unguessable, and long enough that enumeration is not a strategy.
 *  Used for cancel, reschedule and hold tokens, which are the only credential
 *  their links carry. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url')

/** For a credential that is already 256 bits of randomness. A password needs a
 *  slow hash because it is guessable; a random token is not, and the lookup runs
 *  on every agent call, so the cost would buy nothing. */
export const hashToken = (plaintext: string): string =>
  createHash('sha256').update(plaintext, 'utf8').digest('hex')
