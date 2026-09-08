import { createHmac, timingSafeEqual } from 'node:crypto'
import { readCredentials, recordHealth, type AccountContext } from '@rawr/db'
import type { ConnectionTest } from './provider.ts'

/** Per organisation: each one builds its own Webflow app, so one shared secret
 *  could not verify both. */

export const webflowSecret = async (ctx: AccountContext): Promise<string | null> => {
  const stored = await readCredentials(ctx, 'webflow')
  return stored?.secret ?? null
}

/** Data API v2 signs "{timestamp}:{raw body}" and sends the hex digest. */
export const webflowSignatureMatches = (
  secret: string,
  timestamp: string,
  raw: string,
  signature: string,
): boolean => {
  const expected = createHmac('sha256', secret).update(`${timestamp}:${raw}`).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  // timingSafeEqual throws on a length mismatch, and a digest length is public.
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Nothing at Webflow to call, so this only proves the secret decrypts and the
 *  digest agrees. Whether it is the right one shows on the first delivery. */
export const testWebflow = async (ctx: AccountContext): Promise<ConnectionTest> => {
  const secret = await webflowSecret(ctx)
  if (!secret) {
    const detail = 'Paste the client secret of the Webflow OAuth app that creates the webhook.'
    await recordHealth(ctx, 'webflow', { ok: false, error: detail })
    return { ok: false, detail }
  }
  const timestamp = String(Date.now())
  const raw = '{"rawr":"connection-test"}'
  const ok = webflowSignatureMatches(
    secret,
    timestamp,
    raw,
    createHmac('sha256', secret).update(`${timestamp}:${raw}`).digest('hex'),
  )
  if (!ok) {
    const detail = 'The stored secret did not verify its own signature, so it is not usable.'
    await recordHealth(ctx, 'webflow', { ok: false, error: detail, disconnected: true })
    return { ok: false, detail }
  }
  await recordHealth(ctx, 'webflow', { ok: true })
  return {
    ok: true,
    detail:
      'The secret is stored and verifies a signature. Whether it is the right one shows on the first delivery: a mismatch is refused and named here.',
  }
}
