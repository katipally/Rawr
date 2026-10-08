// Sends the same singletonKey twice to a real pg-boss queue and counts what is queued.
// Runs the production convergence path (ensureQueue) between a standard and a short
// queue. Refuses to run unless DATABASE_URL_OWNER names rawr_verify.
import { PgBoss } from 'pg-boss'
import postgres from 'postgres'
import { ensureQueue } from '../src/queue-policy.ts'

const url = process.env.DATABASE_URL_OWNER ?? ''
if (new URL(url).pathname !== '/rawr_verify') throw new Error('Refusing to run: DATABASE_URL_OWNER does not name rawr_verify.')

const boss = new PgBoss({ connectionString: url, schema: 'pgboss', max: 2 })
boss.on('error', (error: unknown) => console.error('[pg-boss]', error))
await boss.start()
const db = postgres(url, { max: 1 })

const name = `singleton-proof-${Date.now()}`
const queued = async () => (await db<{ n: number }[]>`select count(*)::int as n from pgboss.job where name = ${name} and state = 'created'`)[0]?.n ?? -1
const send = (key: string) => boss.send(name, {}, { singletonKey: key })

const results: Record<string, number | string> = {}
try {
  await ensureQueue(boss, db, name, { policy: 'standard', retryLimit: 0, retryDelay: 0 })
  console.log('standard: sends with key "same" =>', await send('same'), await send('same'))
  results.standardQueued = await queued()

  await boss.deleteQueuedJobs(name)
  await ensureQueue(boss, db, name, { policy: 'short', retryLimit: 0, retryDelay: 0 })
  results.policyAfterConvergence = (await boss.getQueue(name))?.policy ?? 'missing'
  console.log('short: sends with key "same" =>', await send('same'), await send('same'))
  results.shortQueued = await queued()

  const before = await queued()
  await send('other-1')
  await send('other-2')
  results.distinctKeysAdded = (await queued()) - before
} finally {
  await boss.deleteQueue(name)
  await boss.stop({ graceful: true, close: true })
  await db.end()
}

console.log(JSON.stringify(results))
const ok = results.standardQueued === 2 && results.policyAfterConvergence === 'short' && results.shortQueued === 1 && results.distinctKeysAdded === 2
if (!ok) {
  console.error('FAILED: expected standard 2, short 1, distinct keys +2')
  process.exit(1)
}
console.log('PASS')
