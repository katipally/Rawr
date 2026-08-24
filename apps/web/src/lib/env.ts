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
