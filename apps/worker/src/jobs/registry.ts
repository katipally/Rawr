import { z } from 'zod'

/** Every payload carries the account it belongs to. A job without one fails
 *  loudly rather than running unscoped. */
export const basePayload = z.object({ accountId: z.uuid() })

type ParseResult = { ok: true; value: unknown } | { ok: false; error: string }

/** Generics are erased at the definition boundary so the runner can hold a list of
 *  differently-shaped jobs without a cast at every call site. */
export type Job = {
  name: string
  /** Retries use exponential backoff with jitter. On final failure the payload and
   *  the real error land in dead_letter, where they can be replayed. */
  retryLimit: number
  retryDelaySeconds: number
  /** The pg-boss policy the queue is created with, for a queue sent with a
   *  singletonKey. `short`: one queued job per key, and a running one does not block
   *  the next (a job that re-sends itself needs this). `exclusive`: one queued or
   *  running job per key. Boot converges an existing queue to it once the queue is empty. */
  policy?: 'short' | 'exclusive' | undefined
  /** Who a whole-run failure belongs to, for a job whose payload names no account.
   *  SQL returning one `account_id` column. */
  audience?: string | undefined
  parse: (data: unknown) => ParseResult
  handle: (value: unknown) => Promise<void>
}

/** A run that failed for some accounts and carried on with the rest. The runner
 *  records one dead letter per account, so the failure lands on the account it hit. */
export class AccountFailures extends Error {
  readonly failures: Map<string, string>

  constructor(failures: Map<string, string>) {
    super(`${failures.size} account(s) failed`)
    this.failures = failures
  }
}

export const defineJob = <Schema extends z.ZodType>(definition: {
  name: string
  schema: Schema
  retryLimit: number
  retryDelaySeconds: number
  policy?: 'short' | 'exclusive' | undefined
  audience?: string | undefined
  handle: (payload: z.output<Schema>) => Promise<void>
}): Job => ({
  name: definition.name,
  retryLimit: definition.retryLimit,
  retryDelaySeconds: definition.retryDelaySeconds,
  policy: definition.policy,
  audience: definition.audience,
  parse: (data) => {
    const result = definition.schema.safeParse(data)
    return result.success
      ? { ok: true, value: result.data }
      : {
          ok: false,
          error: result.error.issues
            .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
            .join('; '),
        }
  },
  handle: (value) => definition.handle(value as z.output<Schema>),
})

/** One step per account. A step that throws is recorded against its account and the
 *  rest still run; the run then fails with the list, so the retry covers only the
 *  accounts that need it and the dead letter lands on each one. */
export const eachAccount = async <T>(
  rows: readonly T[],
  accountOf: (row: T) => string,
  step: (row: T) => Promise<unknown>,
): Promise<void> => {
  const failures = new Map<string, string>()
  for (const row of rows) {
    try {
      await step(row)
    } catch (cause) {
      failures.set(accountOf(row), cause instanceof Error ? cause.message : String(cause))
    }
  }
  if (failures.size > 0) throw new AccountFailures(failures)
}

export const accountIdOf = (value: unknown): string | null => {
  const candidate = (value as { accountId?: unknown } | null)?.accountId
  return typeof candidate === 'string' ? candidate : null
}

/** "sandbox 3, datasaur 1", for a sweep that crosses tenants. The rows are
 *  already in hand from the sweep's own join, so attributing a log line costs a
 *  pass over them rather than a query each. */
export const bySlug = (rows: { slug: string }[]): string => {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.slug, (counts.get(row.slug) ?? 0) + 1)
  return [...counts].map(([slug, count]) => `${slug} ${count}`).join(', ')
}
