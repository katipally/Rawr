import type { PgBoss, QueuePolicy } from 'pg-boss'
import type { Sql } from 'postgres'

/** Creates a queue with its policy, or brings an existing one to it. pg-boss fixes a
 *  queue's policy when it is created and will not change it in place, so a mismatch
 *  drops the queue and its jobs. That waits until the queue is empty; until then the
 *  queue keeps its old policy and the next boot converges it.
 *
 *  The emptiness check reads the job table, not pg-boss's queue stats, which are a
 *  snapshot refreshed on a schedule and can still show jobs that were just deleted. */
export const ensureQueue = async (
  queue: PgBoss,
  db: Sql,
  name: string,
  options: { policy: QueuePolicy; retryLimit: number; retryDelay: number },
): Promise<void> => {
  const existing = await queue.getQueue(name)
  if (existing && existing.policy !== options.policy) {
    const [row] = await db<{ n: number }[]>`
      select count(*)::int as n from pgboss.job
       where name = ${name} and state in ('created', 'retry', 'active')`
    const n = row?.n ?? 0
    if (n === 0) {
      await queue.deleteQueue(name)
    } else {
      console.warn(`[worker] ${name} is ${existing.policy} with ${n} job(s) in it; it becomes ${options.policy} once empty.`)
    }
  }
  await queue.createQueue(name, {
    policy: options.policy,
    retryLimit: options.retryLimit,
    retryDelay: options.retryDelay,
    retryBackoff: true,
  })
}
