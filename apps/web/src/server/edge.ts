import { hashIp } from '@rawr/db'
import type { NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'

/** Everything the public edge needs from a request, read in one place so no route
 *  reaches into headers on its own and gets the precedence wrong. */

/** The client address, read from the right end of x-forwarded-for.
 *
 *  The header is a list appended to by each hop, so the entries a proxy we run
 *  added are the LAST ones, and everything before them is whatever the caller
 *  chose to send. Reading the first entry therefore reads the attacker's own
 *  string: sending a fresh `x-forwarded-for` on every request lands each one in
 *  its own rate-limit bucket, and the per-IP limits on the submit endpoint stop
 *  meaning anything.
 *
 *  So this counts back past the hops we actually run. TRUSTED_PROXY_HOPS is that
 *  count, and it defaults to one, which is what a single reverse proxy in front of
 *  the app produces. Set it to match the deployment: too low reads a spoofable
 *  entry, too high reads the proxy's own address and puts every visitor in one
 *  bucket, so it is deliberately explicit rather than guessed.
 *
 *  Still used only for rate limiting and a rotating hash. It is never stored. */
export const clientIpFrom = (get: (name: string) => string | null): string | null => {
  const forwarded = get('x-forwarded-for')
  if (forwarded) {
    const hops = forwarded.split(',').map((entry) => entry.trim()).filter(Boolean)
    // The last entry our own proxy appended: the address it saw, which is the
    // furthest right one no caller could have written.
    const trusted = hops[hops.length - env.TRUSTED_PROXY_HOPS]
    if (trusted) return trusted
  }
  return get('x-real-ip')?.trim() || null
}

/** The same answer from a request. A Server Action has a header jar instead and
 *  calls `clientIpFrom` directly. */
export const clientIp = (request: NextRequest): string | null =>
  clientIpFrom((name) => request.headers.get(name))

export const ipHashOf = (request: NextRequest): string | null =>
  hashIp(clientIp(request), env.EDGE_IP_SALT)

/** Largest body the edge will read. A form is text; anything larger is either a
 *  mistake or an attempt to make the process do work. */
export const MAX_BODY_BYTES = 64 * 1024

/** String length counts UTF-16 units, so 64k characters of anything outside Latin
 *  can be three times the cap in bytes. The limit is a byte budget, so it is
 *  measured in bytes. */
export const byteLength = (text: string): number => new TextEncoder().encode(text).length

export class PayloadTooLarge extends Error {
  constructor() {
    super('That submission is larger than this form accepts.')
    this.name = 'PayloadTooLarge'
  }
}

export class UnreadableBody extends Error {
  constructor() {
    super('That submission could not be read.')
    this.name = 'UnreadableBody'
  }
}

/** The raw body as text, never more than MAX_BODY_BYTES of it held in memory. A
 *  declared length over the cap is refused unread, and the stream is cancelled the
 *  moment the running total crosses it, so a body with no content-length (chunked)
 *  or a lying one costs at most the cap. O(cap). Throws `PayloadTooLarge`. */
export const readRaw = async (request: NextRequest): Promise<string> => {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new PayloadTooLarge()

  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new PayloadTooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Reads a form-encoded or JSON body into a plain object, capped. A JSON body
 *  that is not valid JSON, or not an object, throws `UnreadableBody`.
 *
 *  Repeated keys become an array, which is how a multi_select arrives from a
 *  plain HTML form. Anything else would silently keep only the last checkbox. */
export const readBody = async (request: NextRequest): Promise<Record<string, unknown>> => {
  const text = await readRaw(request)

  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new UnreadableBody()
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UnreadableBody()
    return parsed as Record<string, unknown>
  }

  const params = new URLSearchParams(text)
  const body: Record<string, unknown> = {}
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key)
    body[key] = all.length > 1 ? all : (all[0] ?? '')
  }
  return body
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

type Bucket = { count: number; resetAt: number }

/** In process, deliberately. D2 rules out Redis until it is proven necessary, and
 *  Rawr is one deployment. The cost is that limits are per instance, so a two
 *  instance deploy allows twice the configured rate. That is an acceptable
 *  ceiling for shedding a bot storm, and the spam score still catches what gets
 *  through. Moving this to Postgres would add a write per request, which is the
 *  exact work the limiter exists to avoid.
 *
 *  Bounded so a flood of distinct keys cannot grow the map without limit. */
const MAX_TRACKED_KEYS = 50_000
const buckets = new Map<string, Bucket>()

const sweep = (now: number): void => {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
  if (buckets.size <= MAX_TRACKED_KEYS) return
  // Still over after expiring: drop oldest-inserted keys, which Map preserves.
  const excess = buckets.size - MAX_TRACKED_KEYS
  let dropped = 0
  for (const key of buckets.keys()) {
    buckets.delete(key)
    if (++dropped >= excess) break
  }
}

export type RateLimit = { allowed: boolean; retryAfterSeconds: number }

export const rateLimit = (key: string, limit: number, windowSeconds: number): RateLimit => {
  const now = Date.now()
  if (buckets.size > MAX_TRACKED_KEYS) sweep(now)

  const existing = buckets.get(key)
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 })
    return { allowed: true, retryAfterSeconds: 0 }
  }
  existing.count += 1
  if (existing.count > limit) {
    return { allowed: false, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) }
  }
  return { allowed: true, retryAfterSeconds: 0 }
}

/** F3 §5. Per IP and per form, plus a global per-form ceiling so one form under a
 *  bot storm cannot consume the process on behalf of every other form. */
export const checkSubmitLimits = (formId: string, ip: string | null): RateLimit => {
  const who = ip ?? 'unknown'
  const perMinute = rateLimit(`f:${formId}:${who}:m`, 5, 60)
  if (!perMinute.allowed) return perMinute
  const perHour = rateLimit(`f:${formId}:${who}:h`, 30, 3600)
  if (!perHour.allowed) return perHour
  return rateLimit(`f:${formId}:all`, 600, 60)
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** The embed runs on datasaur.ai, a different origin, so the submit endpoint has
 *  to answer preflight. It is intentionally open: the endpoint creates a lead and
 *  returns no record data, so restricting the origin would only break the copy
 *  site and the staging domain without protecting anything. */
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  // PUT is the file endpoint's; every other edge route exports no such handler
  // and answers one with 405, so advertising it here costs nothing.
  'access-control-allow-methods': 'POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}

/** For the endpoints an MCP client or a browser-based one calls with a bearer token.
 *  No cookie is read, so any origin may call them. */
const BEARER_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-method, mcp-name',
  'access-control-expose-headers': 'www-authenticate, retry-after',
  'access-control-max-age': '86400',
}

export const corsPreflight = (methods: string): Response =>
  new Response(null, { status: 204, headers: { ...BEARER_CORS, 'access-control-allow-methods': methods } })

export const withCors = (response: Response): Response => {
  for (const [name, value] of Object.entries(BEARER_CORS)) response.headers.set(name, value)
  return response
}

/** How a route that answers with its own wording should refuse a body
 *  `readBody` rejected. */
export const bodyRefusal = (cause: unknown): { error: string; status: 400 | 413 } =>
  cause instanceof PayloadTooLarge
    ? { error: 'That request is larger than this page accepts.', status: 413 }
    : { error: 'That request could not be read.', status: 400 }

/** The one answer for any inbound request that cannot prove who it is: unknown
 *  account key, unknown or inactive form, provider not connected, missing or wrong
 *  signature all read the same, so a caller learns nothing about what exists. The
 *  specific reason goes to the server log only. */
export const unverified = (route: string, reason: string): Response => {
  console.warn(`[inbound] ${route} rejected: ${reason}`)
  return Response.json({ error: 'That request could not be verified.' }, { status: 401 })
}
