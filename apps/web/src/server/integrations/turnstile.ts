import { readCredentials, recordHealth, type AccountContext } from '@rawr/db'
import type { ConnectionTest } from './provider.ts'

/** The site key is rendered into the browser, so only the secret is encrypted. */

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export type TurnstileCredentials = { siteKey: string; secret: string }

/** Half a pair reads as none: a widget whose answer nothing checks is theatre. */
export const turnstileCredentials = async (
  ctx: AccountContext,
): Promise<TurnstileCredentials | null> => {
  const stored = await readCredentials(ctx, 'turnstile')
  if (!stored?.secret) return null
  const config = stored.config as { siteKey?: unknown }
  const siteKey = typeof config.siteKey === 'string' ? config.siteKey.trim() : ''
  return siteKey ? { siteKey, secret: stored.secret } : null
}

export type TurnstileOutcome = 'passed' | 'failed' | 'unavailable'

/** 'unavailable' rather than a throw: a lead is quarantined, never lost. */
export const verifyTurnstile = async (
  creds: TurnstileCredentials,
  token: unknown,
  ip: string | null,
): Promise<TurnstileOutcome> => {
  if (typeof token !== 'string' || token === '') return 'failed'

  const body = new URLSearchParams({ secret: creds.secret, response: token })
  if (ip) body.set('remoteip', ip)

  try {
    const response = await fetch(SITEVERIFY, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return 'unavailable'
    const result = (await response.json()) as { success?: boolean }
    return result.success === true ? 'passed' : 'failed'
  } catch {
    return 'unavailable'
  }
}

/** Cloudflare has no validate endpoint, so a known-bad token is posted and the
 *  error codes say whether the secret or only the token was refused. */
export const testTurnstile = async (ctx: AccountContext): Promise<ConnectionTest> => {
  const creds = await turnstileCredentials(ctx)
  if (!creds) {
    const detail = 'Paste the site key and the secret key from the same Turnstile widget.'
    await recordHealth(ctx, 'turnstile', { ok: false, error: detail })
    return { ok: false, detail }
  }

  try {
    const response = await fetch(SITEVERIFY, {
      method: 'POST',
      body: new URLSearchParams({ secret: creds.secret, response: 'rawr-connection-test' }),
      signal: AbortSignal.timeout(5000),
    })
    const result = (await response.json()) as { 'error-codes'?: string[] }
    const codes = result['error-codes'] ?? []
    if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
      const detail = `Cloudflare did not recognise that secret: ${codes.join(', ')}.`
      await recordHealth(ctx, 'turnstile', { ok: false, error: detail, disconnected: true })
      return { ok: false, detail }
    }
    await recordHealth(ctx, 'turnstile', { ok: true })
    return {
      ok: true,
      detail: 'Cloudflare accepted the secret and refused the dummy token, which is the right pair of answers.',
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    await recordHealth(ctx, 'turnstile', { ok: false, error: detail })
    return { ok: false, detail }
  }
}
