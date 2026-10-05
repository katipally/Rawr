const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. The worker cannot start without it.`)
  return value
}

/** Session-mode pooler. pg-boss owns its schema, so it connects as the table owner;
 *  job handlers that touch tenant data go through the data access layer instead and
 *  are subject to row level security like everything else. */
export const OWNER_URL = required('DATABASE_URL_OWNER')

/** Six job families ask the app to do the work and prove they are the worker with
 *  this. Without it they each threw at run time, once a cycle, for ever: the
 *  worker booted clean, logged "ready", and then quietly dead-lettered mail sync,
 *  mail hydration, sequence steps, automation resumes, integration health and the
 *  Apollo sync. Failing here turns a silent outage into a start-up error. */
export const INTERNAL_SECRET = required('RAWR_INTERNAL_SECRET')

/** Named for the same reason, and not exported because nothing here opens it:
 *  @rawr/db does, on first use. Five jobs go through the data access layer -- the
 *  activity roll-up, segment evaluation, fill rates, deal scoring and visitor
 *  stitching -- so a worker started without it boots clean, logs "ready", and then
 *  dead-letters every one of them once a cycle. */
required('DATABASE_URL')

/** Where the worker reaches the web app. Both run in one container, so
 *  the loopback address and the port the app was told to listen on is the answer
 *  whenever nobody has named an external one. An empty string is a variable
 *  somebody set and then cleared, which has to fall back like an absent one, or
 *  every internal call goes to `undefined/api/...`. */
export const resolveAppBase = (env: { RAWR_INTERNAL_URL?: string; PORT?: string }): string =>
  env.RAWR_INTERNAL_URL?.trim() || `http://127.0.0.1:${env.PORT ?? 3000}`

export const APP_BASE = resolveAppBase(process.env)

/** Whether the import and bulk dispatchers step over the fixture tenants, the
 *  ones the seed marks `is_fixture`.
 *
 *  On the deployment that shares its database with those fixtures they have to be
 *  stepped over: the verify suites drive their own runs there, one chunk at a
 *  time, and a worker picking the same run up races them. Anywhere else the
 *  fixtures are the only tenants there are to test an import against, and a
 *  worker that ignores them looks exactly like a worker that is not running. */
export const skipsFixtures = (env: { RAWR_WORKER_SKIPS_FIXTURES?: string }): boolean =>
  env.RAWR_WORKER_SKIPS_FIXTURES?.trim() === '1'

export const SKIPS_FIXTURES = skipsFixtures(process.env)

const CRON = /^\S+ \S+ \S+ \S+ \S+$/

/** A different cron expression for a job than the one the worker ships with, as
 *  JSON from `RAWR_WORKER_SCHEDULES`: {"import.dispatch": "*\/5 * * * *"}. Eight
 *  jobs fire every minute and fan out across every tenant, which a deployment with
 *  one small database may want slower, and a deployment with none of the work they
 *  poll for may want off the clock. A malformed value stops the start-up: a
 *  schedule that silently reverted would be a job running at a rate nobody chose. */
export const scheduleOverrides = (env: { RAWR_WORKER_SCHEDULES?: string }): Record<string, string> => {
  const raw = env.RAWR_WORKER_SCHEDULES?.trim()
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('RAWR_WORKER_SCHEDULES is not JSON. Expected {"job-name": "cron expression"}.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('RAWR_WORKER_SCHEDULES must be an object of job names to cron expressions.')
  }
  const out: Record<string, string> = {}
  for (const [name, cron] of Object.entries(parsed)) {
    if (typeof cron !== 'string' || !CRON.test(cron.trim())) {
      throw new Error(`RAWR_WORKER_SCHEDULES: "${name}" needs a five field cron expression.`)
    }
    out[name] = cron.trim()
  }
  return out
}

export const SCHEDULE_OVERRIDES = scheduleOverrides(process.env)
