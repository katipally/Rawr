import { createHmac, timingSafeEqual } from 'node:crypto'
import { publicEdgeContext, readCredentials, recordHealth, workspaceIdForSite } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { handleApolloWebhook } from '~/server/integrations/apollo.ts'
import { handleBrevoWebhook } from '~/server/integrations/brevo.ts'
import { handleClayWebhook } from '~/server/integrations/clay.ts'
import { handleWoodpeckerWebhook } from '~/server/integrations/woodpecker.ts'
import { clientIp, rateLimit } from '~/server/edge.ts'

/** POST /w/:source — F0 §6's fourth public endpoint, and F6 §1's inbound half.
 *
 *  Per-provider signature verification, a replay window, and an idempotency key,
 *  in that order. A webhook with an invalid signature is rejected, logged and
 *  counted; a spike raises the integration's health rather than passing silently.
 *
 *  A provider retries on a non-2xx, so anything that can never be processed answers
 *  200 with a reason rather than inviting an infinite retry. Only a genuine "try me
 *  again" answers 5xx. */

const REPLAY_WINDOW_MS = 5 * 60 * 1000

const SOURCES = ['brevo', 'apollo', 'clay', 'woodpecker'] as const
type Source = (typeof SOURCES)[number]

const isSource = (value: string): value is Source => (SOURCES as readonly string[]).includes(value)

const accepted = (detail: string): NextResponse => NextResponse.json({ ok: true, detail }, { status: 200 })

const rejected = (detail: string, status: number): NextResponse =>
  NextResponse.json({ ok: false, detail }, { status })

/** Constant time, and the length check first because timingSafeEqual throws on a
 *  mismatch and the length of a signature is not the secret. */
const signatureMatches = (expected: string, presented: string): boolean => {
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const POST = async (
  request: NextRequest,
  { params }: { params: Promise<{ source: string }> },
): Promise<NextResponse> => {
  const { source } = await params
  if (!isSource(source)) return rejected(`Rawr takes no webhooks from "${source}".`, 404)

  // An unauthenticated endpoint that writes to a timeline is worth shedding load
  // on even before the signature is checked.
  const limit = rateLimit(`w:${source}:${clientIp(request) ?? 'unknown'}`, 300, 60)
  if (!limit.allowed) {
    return rejected('Too many requests.', 429)
  }

  // The workspace comes from the site key in the query, never from the body: a
  // caller must not be able to name the tenant it writes into. F0 §2.
  const siteKey = request.nextUrl.searchParams.get('w') ?? ''
  const workspaceId = siteKey ? await workspaceIdForSite(siteKey) : null
  if (!workspaceId) {
    return rejected('That webhook URL is missing the workspace key Rawr issued with it.', 404)
  }

  const ctx = publicEdgeContext(workspaceId)
  const raw = await request.text()

  const stored = await readCredentials(ctx, source)
  if (!stored?.secret) {
    return rejected(`${source} is not connected in this workspace, so its webhooks are refused.`, 503)
  }

  const verified = verify(source, request, raw, stored.secret, stored.config)
  if (!verified.ok) {
    // Counted against the integration's health, so a spike of bad signatures is
    // visible rather than silently dropped. F6's edge-case table.
    await recordHealth(ctx, source, { ok: false, error: `Rejected webhook: ${verified.detail}` })
    return rejected(verified.detail, 401)
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return accepted('That body was not JSON, so there is nothing to record. Not retried.')
  }

  try {
    const outcome =
      source === 'brevo'
        ? await handleBrevoWebhook(ctx, body)
        : source === 'apollo'
          ? await handleApolloWebhook(ctx, body)
          : source === 'woodpecker'
            ? await handleWoodpeckerWebhook(ctx, body)
            : await handleClayWebhook(ctx, body)
    return accepted(outcome.detail)
  } catch (cause) {
    // A real failure: the provider should try again.
    const message = cause instanceof Error ? cause.message : String(cause)
    await recordHealth(ctx, source, { ok: false, error: message })
    return rejected(message, 500)
  }
}

type Verified = { ok: true } | { ok: false; detail: string }

/** Each provider signs differently, so this is the one place that knows how. Clay
 *  has no signature at all, so a shared secret in a header is what stands in;
 *  without it the endpoint would be an open enrichment-injection hole. */
const verify = (
  source: Source,
  request: NextRequest,
  raw: string,
  secret: string,
  config: Record<string, unknown>,
): Verified => {
  if (source === 'brevo') {
    // Brevo signs nothing. The URL it was given carries a token Rawr minted when
    // the integration was saved, and that token is the whole proof.
    const expected = typeof config.webhookToken === 'string' ? config.webhookToken : ''
    const presented = request.nextUrl.searchParams.get('t') ?? ''
    if (!expected) return { ok: false, detail: 'Brevo has no webhook token yet. Save the integration once to issue one.' }
    if (!presented) return { ok: false, detail: 'That request carried no Brevo webhook token.' }
    return signatureMatches(expected, presented)
      ? { ok: true }
      : { ok: false, detail: 'That Brevo webhook token does not match this workspace’s.' }
  }

  if (source === 'apollo') {
    const timestamp = request.headers.get('x-apollo-timestamp') ?? ''
    const presented = request.headers.get('x-apollo-signature') ?? ''
    if (!presented || !timestamp) {
      return { ok: false, detail: 'That request carried no Apollo signature and timestamp.' }
    }
    const age = Math.abs(Date.now() - Number(timestamp) * 1000)
    if (!Number.isFinite(age) || age > REPLAY_WINDOW_MS) {
      return { ok: false, detail: 'That Apollo delivery is outside the replay window.' }
    }
    const expected = createHmac('sha256', secret).update(`${timestamp}:${raw}`).digest('hex')
    return signatureMatches(expected, presented)
      ? { ok: true }
      : { ok: false, detail: 'That Apollo signature does not match this workspace’s key.' }
  }

  if (source === 'woodpecker') {
    // Woodpecker signs its deliveries, but the header it signs with is not in the
    // public documentation, and a verification written from a guess is worse than
    // none: it would either reject every real delivery or accept every forged one.
    // So the proof is the token in the URL Rawr minted, exactly as for Brevo, and
    // that token is the only thing that makes the endpoint writable.
    const expected = typeof config.webhookToken === 'string' ? config.webhookToken : ''
    const presented = request.nextUrl.searchParams.get('t') ?? ''
    if (!expected) {
      return { ok: false, detail: 'Woodpecker has no webhook token yet. Save the integration once to issue one.' }
    }
    if (!presented) return { ok: false, detail: 'That request carried no Woodpecker webhook token.' }
    return signatureMatches(expected, presented)
      ? { ok: true }
      : { ok: false, detail: 'That Woodpecker webhook token does not match this workspace’s.' }
  }

  const presented = request.headers.get('x-clay-webhook-auth') ?? ''
  return signatureMatches(secret, presented)
    ? { ok: true }
    : { ok: false, detail: 'That request did not carry the shared secret Clay was configured with.' }
}
