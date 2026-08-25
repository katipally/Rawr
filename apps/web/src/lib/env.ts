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
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
  throw new Error(`Environment is not usable:\n${lines.join('\n')}`)
}

export const env = parsed.data

export const googleConfigured = env.GOOGLE_CLIENT_ID !== '' && env.GOOGLE_CLIENT_SECRET !== ''

/** Dev sign-in exists so the role matrix and the isolation tests can be exercised
 *  before Google Cloud access lands. It refuses to be reachable in production even
 *  if the variable is set. */
export const devLoginEnabled = env.RAWR_DEV_LOGIN === '1' && env.NODE_ENV !== 'production'

export const turnstileConfigured = env.TURNSTILE_SITE_KEY !== '' && env.TURNSTILE_SECRET !== ''

export const slackConfigured = env.SLACK_BOT_TOKEN !== '' || env.SLACK_WEBHOOK_URL !== ''

/** The embed and the hosted page are loaded from another origin, so they need an
 *  absolute base. Falls back to AUTH_URL, which is correct in development. */
export const publicBaseUrl = env.PUBLIC_BASE_URL ?? env.AUTH_URL
