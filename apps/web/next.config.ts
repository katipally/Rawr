import type { NextConfig } from 'next'

/** Two populations, two answers.
 *
 *  The app is for signed-in staff and must never be framed: a CRM inside somebody
 *  else's iframe is a clickjacked CRM. The public edge is the opposite. The embed,
 *  the hosted form and the booking page are loaded onto datasaur.ai and a Webflow
 *  copy site, so denying frame-ancestors there would break the one thing they
 *  exist to do.
 *
 *  So the headers below are split by path rather than applied once at the root.
 *  Everything both populations agree on is in BASELINE. */

/** Set on every response.
 *
 *  HSTS is deliberately absent: it is a promise about the whole origin that
 *  cannot be taken back for two years, and until open item 9 picks a hosting
 *  target there is no origin to make it about. It belongs in the reverse proxy's
 *  config next to the certificate, not here. */
const BASELINE = [
  { key: 'x-content-type-options', value: 'nosniff' },
  // Full URL to our own origin, only the origin to anyone else. A record page
  // address names an id, and that does not belong in another site's logs.
  { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
  // Nothing here asks for a camera, a microphone or a location, so nothing may.
  { key: 'permissions-policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
]

/** React's development build calls eval() to rebuild a callstack across the
 *  server and client boundary, so a CSP without 'unsafe-eval' turns every dev
 *  error overlay into a second error about the overlay. It never calls eval in
 *  production, which is why this is the one directive that differs by build. */
const DEV_ONLY_SCRIPT = process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"

/** The signed-in app.
 *
 *  'unsafe-inline' on styles is Tailwind's runtime and the inline style attributes
 *  React writes; removing it needs a nonce threaded through the streamed HTML,
 *  which is its own change. Scripts come from this origin and from Google Fonts'
 *  CSS only. */
const APP_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${DEV_ONLY_SCRIPT}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com",
  // The record screens talk to this origin, and Turnstile when a form is embedded.
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  // The modern spelling of X-Frame-Options, and the one that takes a list.
  "frame-ancestors 'none'",
].join('; ')

/** The public edge: /embed.js, /booking.js, the hosted form and booking pages, and
 *  the endpoints they post to. Framed on purpose, so frame-ancestors is absent
 *  rather than set to 'none'. Everything else still applies. */
const EDGE_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com${DEV_ONLY_SCRIPT}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ')

/** Every public path, kept next to the list in the README so the two cannot drift. */
const EDGE_PATHS = [
  '/embed.js',
  '/booking.js',
  '/f/:path*',
  '/form/:path*',
  '/b/:path*',
  '/c',
  '/e',
  '/w/:path*',
]

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source, not a build step.
  transpilePackages: ['@rawr/db', '@rawr/ui'],
  // Every address is built in ~/lib/links.ts, which is the typed layer. Typed
  // routes would demand a cast at each of the hundred places those strings land.
  typedRoutes: false,
  // This repo already has its own agent instructions; Next should not write more.
  agentRules: false,

  // Every matching entry applies and the last one wins per header, so the
  // catch-all goes first and the public paths override it. The other order gives
  // the whole app the edge policy, which is the wrong way round to be wrong.
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        ...BASELINE,
        { key: 'content-security-policy', value: APP_CSP },
        // For anything still reading the header CSP replaced.
        { key: 'x-frame-options', value: 'DENY' },
      ],
    },
    ...EDGE_PATHS.map((source) => ({
      source,
      headers: [
        ...BASELINE,
        { key: 'content-security-policy', value: EDGE_CSP },
        // Undoes the DENY above. An empty value is what removes a header here;
        // omitting the key would leave the catch-all's DENY in place and the
        // embed would render as a blank frame on datasaur.ai.
        { key: 'x-frame-options', value: '' },
      ],
    })),
  ],
}

export default config
