import { env } from '~/lib/env.ts'

/** Where this Rawr is reachable from, answered per request.
 *
 *  Distinct from `publicBaseUrl`, and deliberately so. That one is pinned to an
 *  environment variable because it is baked into things that outlive the request:
 *  a link in a booking confirmation, the src of an embed script on somebody
 *  else's site, an unsubscribe URL in a header. Those must not depend on which
 *  host happened to serve the page that created them.
 *
 *  This one answers a different question. An MCP client asks the server "where
 *  are you, and where do I get a token", and the only correct answer is the
 *  origin it just reached us on. Pinning that to a variable means moving Rawr —
 *  to a tunnel, a staging host, a customer's own domain — silently advertises the
 *  old address and every agent connection fails with nothing to read. So the
 *  request wins, and PUBLIC_BASE_URL stays available as an override for the
 *  deployment that genuinely needs to name itself.
 *
 *  The forwarded headers are read the same way `clientIp` reads them: counting
 *  back past the proxies we actually run, because everything to the left of them
 *  is whatever the caller chose to send. */

const lastTrusted = (value: string | null): string | null => {
  if (!value) return null
  const hops = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  return hops[hops.length - env.TRUSTED_PROXY_HOPS] ?? null
}

/** Only what a URL origin may contain. A Host header is caller-controlled on a
 *  deployment with no proxy in front, so anything with a path, a scheme or
 *  whitespace in it is refused rather than concatenated into a metadata document. */
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i

export const originFrom = (get: (name: string) => string | null): string => {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, '')

  const host = lastTrusted(get('x-forwarded-host')) ?? get('host')
  if (!host || !HOST.test(host)) return env.AUTH_URL.replace(/\/$/, '')

  const proto = lastTrusted(get('x-forwarded-proto'))
  // A loopback host is served over plain http in development and nowhere else.
  const scheme = proto === 'http' || proto === 'https'
    ? proto
    : /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(host)
      ? 'http'
      : 'https'

  return `${scheme}://${host}`
}

/** The same answer, for a server component or route handler that has no request
 *  object in hand.
 *
 *  `next/headers` is imported here rather than at the top of the file so the
 *  resolution rules above can be unit tested outside a Next runtime, which is
 *  where a mistake in them would otherwise only show up as agents failing to
 *  connect on a host nobody tested. */
export const requestOrigin = async (): Promise<string> => {
  const { headers } = await import('next/headers')
  const jar = await headers()
  return originFrom((name) => jar.get(name))
}
