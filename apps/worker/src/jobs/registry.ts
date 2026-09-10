import { z } from 'zod'

/** Every payload carries the account it belongs to. A job without one fails
 *  loudly rather than running unscoped. */
export const basePayload = z.object({ accountId: z.uuid() })

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string }

/** Generics are erased at the definition boundary so the runner can hold a list of
 *  differently-shaped jobs without a cast at every call site. */
export type Job = {
  name: string
  /** Retries use exponential backoff with jitter. On final failure the payload and
   *  the real error land in dead_letter, where they can be replayed. */
  retryLimit: number
  retryDelaySeconds: number
  parse: (data: unknown) => ParseResult
  handle: (value: unknown) => Promise<void>
}

export const defineJob = <Schema extends z.ZodType>(definition: {
  name: string
  schema: Schema
  retryLimit: number
  retryDelaySeconds: number
  handle: (payload: z.output<Schema>) => Promise<void>
}): Job => ({
  name: definition.name,
  retryLimit: definition.retryLimit,
  retryDelaySeconds: definition.retryDelaySeconds,
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
