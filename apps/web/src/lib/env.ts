import { z } from 'zod'

/** Read once, at boot, so a missing variable is a startup error with a name in it
 *  rather than a runtime crash three screens deep. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters.'),
  AUTH_URL: z.url(),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  /** Empty means any Google account may sign in, seated by invitation or by an
   *  account whose own domain matches. Set it to lock sign-in to one domain. */
  GOOGLE_HOSTED_DOMAIN: z.string().default(''),
  /** The account an otherwise unseated person joins to read. Empty means a
   *  sign-in that matches no domain and holds no invitation gets no seat, which is
   *  the right answer for a deployment that serves one company. */
  RAWR_VISITOR_ACCOUNT: z.string().default(''),

  /** Where the public edge is reachable from the outside. The embed script and
   *  the hosted form page both build absolute URLs from it, and they are served
   *  onto datasaur.ai, so it is never inferred from the request host. */
  PUBLIC_BASE_URL: z.url().optional(),
  /** Rotated by changing this value. IPs are hashed with it and a day stamp and
   *  are never stored raw. */
  EDGE_IP_SALT: z.string().min(16).default('rawr-development-ip-salt-not-for-production'),
  /** How many proxies we run sit in front of the app, so the client address can be
   *  read from the right end of x-forwarded-for rather than from whatever the
   *  caller put at the left. One is a single reverse proxy, which is the default
   *  shape. This has to match the deployment or the per-IP rate limits are either
   *  spoofable or shared by everybody. */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(8).default(1),
  /** Bumping this re-prompts everyone whose stored choice predates the change. */
  CONSENT_POLICY_VERSION: z.string().default('2026-08-24'),

  /** Object storage over the S3 protocol. Absent means the Files panel says it is
   *  not connected rather than half-working. */
  S3_ENDPOINT: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  /** Never reaches the browser: what does is a URL signed for one key and one
   *  operation, minted per upload and per read. */
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_BUCKET: z.string().default(''),
  /** Required by the protocol even where the host ignores it. */
  S3_REGION: z.string().default('us-east-1'),

  /** --- F2 booking ------------------------------------------------------- */
  /** 32 bytes, base64 or hex, from a secrets store. It encrypts the calendar and
   *  mailbox tokens Rawr holds, and must not live in the database it protects
   */
  TOKEN_ENCRYPTION_KEY: z.string().default(''),
  /** Open item 3 is outstanding, so there is no Google project to read free-busy
   *  from. This lets a host be marked available with Rawr's own bookings as the
   *  only source of busy time, which is what makes the engine exercisable end to
   *  end today. It refuses to be reachable in production. */
  RAWR_DEV_CALENDAR: z.string().optional(),
  /** Whether signing in also asks for the calendar. Off unless set to 1: the
   *  calendar scopes are "restricted", so an OAuth client Google has not verified
   *  refuses the whole authorisation over them, and a policy on Google's side then
   *  stops people signing in to the CRM at all. Turn it on once the client is
   *  verified, and hosts connect their calendar from Meetings, Calendars until
   *  then. */
  RAWR_CALENDAR_AT_SIGNIN: z.string().optional(),
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

/** A deployment that serves one company locks sign-in to its domain; one that does
 *  not leaves this empty and seats people by invitation. */
export const hostedDomainRequired = env.GOOGLE_HOSTED_DOMAIN !== ''

/** Whether anybody who can sign in gets a read-only seat. True on the demo
 *  deployment, false where seats are earned by a domain or an invitation. */
export const visitorAccessOpen = env.RAWR_VISITOR_ACCOUNT !== ''

/** Free-busy and event writing both need Google credentials and a key to encrypt
 *  the grants with. Without either, every host falls back to the dev provider or to
 *  being unavailable, which is the safe direction. */
export const googleCalendarConfigured = googleConfigured && env.TOKEN_ENCRYPTION_KEY !== ''

/** Never in production: a booking confirmed against a calendar nobody checked is
 *  worse than no booking. */
export const devCalendarEnabled = env.RAWR_DEV_CALENDAR === '1' && env.NODE_ENV !== 'production'

export const calendarAtSignIn = env.RAWR_CALENDAR_AT_SIGNIN === '1'

/** F1 phase B. A stand-in Gmail so the sync, the matching and the blocklist are
 *  exercisable before a Google consent screen exists. */
export const devGmailEnabled = env.RAWR_DEV_GMAIL === '1' && env.NODE_ENV !== 'production'

/** F6. Stand-in providers for Brevo, Apollo, Clay, Slack and GA4, so the framework
 *  — connection test, health, idempotency, retry, dead letter, replay — is
 *  exercisable before those provider accounts exist. Nothing leaves the machine. */
export const devIntegrationsEnabled =
  env.RAWR_DEV_INTEGRATIONS === '1' && env.NODE_ENV !== 'production'

/** The embed and the hosted page are loaded from another origin, so they need an
 *  absolute base. Falls back to AUTH_URL, which is correct in development. */
export const publicBaseUrl = env.PUBLIC_BASE_URL ?? env.AUTH_URL
