/** Imported first by every script that writes fixtures or destroys rows, so it
 *  runs before anything connects. Refuses a database that is not on this machine,
 *  because the suites and the seed empty tables and `.env.local` has held the
 *  production URL.
 *
 *  Migrating is not guarded: that is how a deploy reaches production. */

const URL_VARS = ['DATABASE_URL', 'DATABASE_URL_OWNER', 'DATABASE_URL_SESSION']

const isLocal = (host: string) => host === '' || host === 'localhost' || host === '[::1]' || host.startsWith('127.')

// An unparseable URL counts as remote: failing closed beats guessing its host.
const remote = URL_VARS.filter((name) => {
  const value = process.env[name]
  if (!value) return false
  try {
    return !isLocal(new URL(value).hostname)
  } catch {
    return true
  }
})

if (remote.length > 0 && process.env.RAWR_ALLOW_REMOTE_DB !== '1') {
  throw new Error(
    `${remote.join(' and ')} point${remote.length === 1 ? 's' : ''} at a database that is not on this machine, and this script writes or deletes rows. ` +
      'Point it at a local Postgres, or set RAWR_ALLOW_REMOTE_DB=1 if you mean to run it against that database.',
  )
}
