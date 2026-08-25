import { hashIp } from '@rawr/db'
import type { NextRequest } from 'next/server'
import { env, turnstileConfigured } from '~/lib/env.ts'

/** Everything the public edge needs from a request, read in one place so no route
 *  reaches into headers on its own and gets the precedence wrong. */

/** The client address. Trusts x-forwarded-for's first entry, which is correct
 *  behind a single reverse proxy and is what every hosting target in open item 9
 *  provides. It is used only for rate limiting and a rotating hash, never stored,
 *  so a spoofed value costs an attacker their own rate-limit bucket and nothing else. */
export const clientIp = (request: NextRequest): string | null => {
  const forwarded = request.headers.get('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  if (first) return first
  return request.headers.get('x-real-ip')?.trim() || null
}

export const ipHashOf = (request: NextRequest): string | null =>
  hashIp(clientIp(request), env.EDGE_IP_SALT)

/** Largest body the edge will read. A form is text; anything larger is either a
 *  mistake or an attempt to make the process do work. */
export const MAX_BODY_BYTES = 64 * 1024

export class PayloadTooLarge extends Error {
  constructor() {
    super('That submission is larger than this form accepts.')
    this.name = 'PayloadTooLarge'
  }
}

/** Reads a form-encoded or JSON body into a plain object, capped.
 *
 *  Repeated keys become an array, which is how a multi_select arrives from a
 *  plain HTML form. Anything else would silently keep only the last checkbox. */
export const readBody = async (request: NextRequest): Promise<Record<string, unknown>> => {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new PayloadTooLarge()

  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new PayloadTooLarge()

  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(text)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
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
// Turnstile
// ---------------------------------------------------------------------------

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Server side only: the secret never reaches the browser, or the check is
 *  theatre. Returns 'unavailable' rather than throwing, because an unreachable
 *  Cloudflare must quarantine the lead, not lose it. */
export const verifyTurnstile = async (
  token: unknown,
  ip: string | null,
): Promise<'passed' | 'failed' | 'unavailable'> => {
  if (!turnstileConfigured) return 'unavailable'
  if (typeof token !== 'string' || token === '') return 'failed'

  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token })
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

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** The embed runs on datasaur.ai, a different origin, so the submit endpoint has
 *  to answer preflight. It is intentionally open: the endpoint creates a lead and
 *  returns no record data, so restricting the origin would only break the copy
 *  site and the staging domain without protecting anything. */
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}
