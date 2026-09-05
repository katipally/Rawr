import postgres from 'postgres'

/** Whether this database connection can carry a large value intact.
 *
 *  Written after `verify-mail` failed once storing a 250,000 character message
 *  body with "invalid byte sequence for encoding UTF8: 0x00", then passed three
 *  times. The body was a quarter of a million literal 'x' characters, so there
 *  was no zero byte anywhere in it: something between this process and Postgres
 *  put it there.
 *
 *  What the evidence says, measured on aws-0-us-east-2.pooler.supabase.com:
 *
 *    - It is not Rawr. The failing statement is a plain parameterised insert.
 *    - It is not the driver. node-postgres 8.23 fails at the same rate as
 *      postgres-js 3.4.9 on the same connection, and two independent client
 *      implementations do not share a bug.
 *    - It is not concurrency. A single connection issuing one insert at a time,
 *      with nothing else in the process, still fails.
 *    - It is a size threshold, and the threshold is small: 1KB and 8KB values
 *      were clean over forty attempts each, 32KB and above failed between 12 and
 *      38 percent of the time.
 *
 *  That leaves the pooler. This script is the reproduction to send with a support
 *  ticket, and the way to re-check afterwards.
 *
 *  It is not part of `pnpm verify`: it deliberately provokes failures, and what
 *  it measures is the hosting, not the code. */

const SIZES = [1_024, 8_192, 32_768, 131_072, 524_288, 2_000_000]
const ATTEMPTS = Number(process.env.PROBE_ATTEMPTS ?? 40)

const owner = postgres(process.env.DATABASE_URL_OWNER, { max: 1, onnotice: () => {} })
await owner`drop table if exists large_value_probe`
await owner`create table large_value_probe (id serial primary key, body text)`
await owner`grant all on large_value_probe to rawr_app`
await owner`grant usage, select on sequence large_value_probe_id_seq to rawr_app`
await owner.end()

// One connection, one statement at a time, so nothing here is a race.
const app = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} })
let worst = 0

try {
  console.log(`${ATTEMPTS} serial inserts per size, one connection\n`)
  for (const size of SIZES) {
    // Literal 'x', so any zero byte that arrives was introduced in transit.
    const body = 'x'.repeat(size)
    let corrupted = 0
    let message = ''

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      try {
        await app`insert into large_value_probe (body) values (${body})`
      } catch (cause) {
        corrupted += 1
        if (!message) message = cause instanceof Error ? cause.message.split('\n')[0] : String(cause)
      }
    }

    const percent = Math.round((corrupted / ATTEMPTS) * 100)
    worst = Math.max(worst, percent)
    console.log(
      `${String(size).padStart(9)} bytes  ${String(corrupted).padStart(3)}/${ATTEMPTS}  ${percent}%${message ? `  ${message}` : ''}`,
    )
  }

  console.log('')
  console.log(
    worst === 0
      ? 'every size arrived intact.'
      : `values are being corrupted in transit, worst ${worst}%. Anything Rawr sends above the clean sizes is at risk, not just message bodies.`,
  )
} finally {
  await app.end()
  const cleanup = postgres(process.env.DATABASE_URL_OWNER, { max: 1, onnotice: () => {} })
  await cleanup`drop table large_value_probe`
  await cleanup.end()
}
