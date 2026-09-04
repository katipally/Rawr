import { z } from 'zod'

/** Read once, at boot, so a missing variable is a startup error with a name in it
 *  rather than a runtime crash three screens deep. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters.'),
  AUTH_URL: z.url(),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_HOSTED_DOMAIN: z.string().min(1),
  RAWR_DEV_LOGIN: z.string().optional(),

  /** Where the public edge is reachable from the outside. The embed script and
   *  the hosted form page both build absolute URLs from it, and they are served
   *  onto datasaur.ai, so it is never inferred from the request host. */
  PUBLIC_BASE_URL: z.url().optional(),
  /** Rotated by changing this value. IPs are hashed with it and a day stamp and
   *  are never stored raw. 02-foundation.md §6. */
  EDGE_IP_SALT: z.string().min(16).default('rawr-development-ip-salt-not-for-production'),
  /** How many proxies we run sit in front of the app, so the client address can be
   *  read from the right end of x-forwarded-for rather than from whatever the
   *  caller put at the left. One is a single reverse proxy, which is the default
   *  shape. This has to match the deployment or the per-IP rate limits are either
   *  spoofable or shared by everybody. */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(8).default(1),
  TURNSTILE_SITE_KEY: z.string().default(''),
  TURNSTILE_SECRET: z.string().default(''),
  /** Open item 4. A bot token is the full app; a webhook URL is the fallback that
   *  keeps the notification and loses the health check. */
  SLACK_BOT_TOKEN: z.string().default(''),
  SLACK_WEBHOOK_URL: z.string().default(''),
  SLACK_DEFAULT_CHANNEL: z.string().default('#sales-leads-2026'),
  /** Open item 8's other half: the OAuth app client secret Webflow signs with. */
  WEBFLOW_CLIENT_SECRET: z.string().default(''),
  /** Bumping this re-prompts everyone whose stored choice predates the change. */
  CONSENT_POLICY_VERSION: z.string().default('2026-08-24'),

  /** --- F2 booking ------------------------------------------------------- */
  /** 32 bytes, base64 or hex, from a secrets store. It encrypts the calendar and
   *  mailbox tokens Rawr holds, and must not live in the database it protects
   *  (02-foundation.md §8, open item 9). */
  TOKEN_ENCRYPTION_KEY: z.string().default(''),
  /** Open item 5. A server-to-server OAuth app: one credential for the account,
   *  no per-user consent. Without it, booking falls back to Google Meet. */
  ZOOM_ACCOUNT_ID: z.string().default(''),
  ZOOM_CLIENT_ID: z.string().default(''),
  ZOOM_CLIENT_SECRET: z.string().default(''),
  /** Open item 3 is outstanding, so there is no Google project to read free-busy
   *  from. This lets a host be marked available with Rawr's own bookings as the
   *  only source of busy time, which is what makes the engine exercisable end to
   *  end today. It refuses to be reachable in production. */
  RAWR_DEV_CALENDAR: z.string().optional(),
  RAWR_DEV_GMAIL: z.string().optional(),
  RAWR_DEV_INTEGRATIONS: z.string().optional(),
  /** Shared with the worker so it can ask the app to run a mailbox pass. */
  RAWR_INTERNAL_SECRET: z.string().default(''),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
  throw new Error(`Environment is not usable:\n${lines.join('\n')}`)
}

export const env = parsed.data

/** The values .env.example and the dev setup use are fine on a laptop and a
 *  breach in production. Refused at boot, by name, rather than discovered later.
 *
 *  Called from instrumentation.ts rather than run here. `next build` sets
 *  NODE_ENV=production and renders pages that reach this module, so running the
 *  check at import refused the build on any machine holding dev secrets. A build
 *  is not a boot: what matters is that the server does not start on them. */
export const assertProductionSecrets = (): void => {
  if (env.NODE_ENV !== 'production') return
  const placeholders: string[] = []
  if (/^dev-|not-a-real-secret|replace-before-deploy/.test(env.AUTH_SECRET)) placeholders.push('AUTH_SECRET')
  if (/^dev-|not-for-production/.test(env.RAWR_INTERNAL_SECRET)) placeholders.push('RAWR_INTERNAL_SECRET')
  if (/not-for-production/.test(env.EDGE_IP_SALT)) placeholders.push('EDGE_IP_SALT')
  if (!env.TOKEN_ENCRYPTION_KEY) placeholders.push('TOKEN_ENCRYPTION_KEY (empty, so Gmail and Calendar grants cannot be stored)')
  if (placeholders.length > 0) {
    throw new Error(`Production is running with development values for: ${placeholders.join(', ')}. Set real ones in the secrets store.`)
  }
}

export const googleConfigured = env.GOOGLE_CLIENT_ID !== '' && env.GOOGLE_CLIENT_SECRET !== ''

/** Dev sign-in exists so the role matrix and the isolation tests can be exercised
 *  before Google Cloud access lands. It refuses to be reachable in production even
 *  if the variable is set. */
export const devLoginEnabled = env.RAWR_DEV_LOGIN === '1' && env.NODE_ENV !== 'production'

export const turnstileConfigured = env.TURNSTILE_SITE_KEY !== '' && env.TURNSTILE_SECRET !== ''

export const slackConfigured = env.SLACK_BOT_TOKEN !== '' || env.SLACK_WEBHOOK_URL !== ''

/** Free-busy and event writing both need a Google project. Until open item 3
 *  lands this is false and every host falls back to the dev provider or to being
 *  unavailable, which is the safe direction. */
export const googleCalendarConfigured = googleConfigured && env.TOKEN_ENCRYPTION_KEY !== ''

export const zoomConfigured =
  env.ZOOM_ACCOUNT_ID !== '' && env.ZOOM_CLIENT_ID !== '' && env.ZOOM_CLIENT_SECRET !== ''

/** Never in production: a booking confirmed against a calendar nobody checked is
 *  worse than no booking. */
export const devCalendarEnabled = env.RAWR_DEV_CALENDAR === '1' && env.NODE_ENV !== 'production'

/** F1 phase B. A stand-in Gmail so the sync, the matching and the blocklist are
 *  exercisable before the Google consent screen exists (open item 3). */
export const devGmailEnabled = env.RAWR_DEV_GMAIL === '1' && env.NODE_ENV !== 'production'

/** F6. Stand-in providers for Brevo, Apollo, Clay, Slack and GA4, so the framework
 *  — connection test, health, idempotency, retry, dead letter, replay — is
 *  exercisable before open items 4, 6, 7 and 12 land. Nothing leaves the machine. */
export const devIntegrationsEnabled =
  env.RAWR_DEV_INTEGRATIONS === '1' && env.NODE_ENV !== 'production'

/** The embed and the hosted page are loaded from another origin, so they need an
 *  absolute base. Falls back to AUTH_URL, which is correct in development. */
export const publicBaseUrl = env.PUBLIC_BASE_URL ?? env.AUTH_URL
