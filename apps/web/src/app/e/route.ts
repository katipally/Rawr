import { collect, isBot, isVisitorId, publicSite } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { clientIp, MAX_BODY_BYTES, rateLimit } from '~/server/edge.ts'

/** GET and POST /e — the collector, F4 §2.
 *
 *  Answers 204 to everything. A visitor must never see an analytics endpoint fail,
 *  and an attacker must never learn from the status code whether a site key exists,
 *  whether their user agent was scored as a bot, or whether the row was written.
 *
 *  GET exists because sendBeacon is not available in every browser Webflow serves
 *  and an image beacon is the only thing that survives a page unloading in some of
 *  them. Both paths run the identical checks. */

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
  // Nothing about a beacon is cacheable, and an intermediary caching one would
  // silently drop every page view after the first.
  'cache-control': 'no-store',
}

export const OPTIONS = (): NextResponse => new NextResponse(null, { status: 204, headers: CORS })

const done = (): NextResponse => new NextResponse(null, { status: 204, headers: CORS })

/** Per visitor and per IP hash. A single-page app firing 400 views in one session
 *  is debounced client side and shed here if the debounce was defeated. */
const withinLimits = (visitorId: string, ip: string | null): boolean => {
  if (!rateLimit(`e:v:${visitorId}`, 120, 60).allowed) return false
  return rateLimit(`e:i:${ip ?? 'unknown'}`, 600, 60).allowed
}

/** A client timestamp is accepted only as a hint for a beacon queued while
 *  offline, and only backwards: a clock an hour fast must not put a page view in
 *  the future, and one a week slow must not rewrite last month. */
const CLIENT_CLOCK_WINDOW_MS = 24 * 60 * 60 * 1000

const stampedAt = (hint: unknown): Date => {
  const now = Date.now()
  const claimed = typeof hint === 'number' ? hint : Number(hint)
  if (!Number.isFinite(claimed)) return new Date(now)
  if (claimed > now || claimed < now - CLIENT_CLOCK_WINDOW_MS) return new Date(now)
  return new Date(claimed)
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'msclkid']

/** D17's container, on the analytics side. Read verbatim from the URL the page was
 *  on, so a parameter a future ad platform invents needs no backfill. */
const utmFrom = (url: string): Record<string, string> => {
  try {
    const search = new URL(url).searchParams
    const out: Record<string, string> = {}
    for (const key of UTM_KEYS) {
      const value = search.get(key)
      if (value) out[key] = value.slice(0, 500)
    }
    return out
  } catch {
    return {}
  }
}

const properties = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  // Bounded: a property bag is a handful of scalars, not a document.
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).slice(0, 50))
}

const handle = async (
  request: NextRequest,
  payload: Record<string, unknown>,
): Promise<NextResponse> => {
  const userAgent = request.headers.get('user-agent')
  // Before a visitor row can exist. A bot that creates one has already moved every
  // count on the panel, and no later filter can take that back.
  if (isBot(userAgent)) return done()

  const siteKey = typeof payload.site === 'string' ? payload.site : null
  const visitorId = payload.vid
  if (!siteKey || !isVisitorId(visitorId)) return done()

  const ip = clientIp(request)
  if (!withinLimits(visitorId, ip)) return done()

  const site = await publicSite(siteKey)
  if (!site) return done()

  const rawUrl = typeof payload.url === 'string' ? payload.url : null
  if (!rawUrl) return done()

  let path = '/'
  try {
    path = new URL(rawUrl).pathname
  } catch {
    return done()
  }

  const name = typeof payload.name === 'string' ? payload.name.trim() : ''

  try {
    await collect({
      site,
      visitorId,
      at: stampedAt(payload.t),
      url: rawUrl,
      path,
      title: typeof payload.title === 'string' ? payload.title : null,
      referrer: typeof payload.ref === 'string' ? payload.ref : null,
      utm: utmFrom(rawUrl),
      userAgent,
      country:
        request.headers.get('cf-ipcountry') ??
        request.headers.get('x-vercel-ip-country') ??
        null,
      event: name ? { name, properties: properties(payload.props) } : undefined,
    })
  } catch {
    // Deliberately swallowed, like the consent endpoint. A page view that could
    // not be stored is a lost row; a page view that surfaces a database error at
    // a visitor is a broken website.
  }

  return done()
}

/** sendBeacon posts a Blob typed text/plain, deliberately: that keeps the beacon a
 *  CORS-simple request, so it never costs a preflight and never fails on a page
 *  that unloads before one could complete. The body is JSON whatever the header
 *  says, which is why this reads it rather than the shared form reader. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  let body: Record<string, unknown>
  try {
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return done()
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) return done()
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return done()
    body = parsed as Record<string, unknown>
  } catch {
    return done()
  }
  return handle(request, body)
}

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const search = request.nextUrl.searchParams
  const payload: Record<string, unknown> = Object.fromEntries(search.entries())
  // The image-beacon path cannot send a JSON body, so properties arrive encoded.
  if (typeof payload.props === 'string') {
    try {
      payload.props = JSON.parse(payload.props)
    } catch {
      payload.props = {}
    }
  }
  return handle(request, payload)
}
