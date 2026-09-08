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
