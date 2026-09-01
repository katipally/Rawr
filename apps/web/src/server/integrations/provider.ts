import { recordDeadLetter, type IntegrationKind, type WorkspaceContext } from '@rawr/db'

/** The half of F6 §1 that is about talking to somebody else's server.
 *
 *  Every provider call in Rawr goes through `attempt`, so retry, backoff, jitter,
 *  the finite ceiling and the dead-letter row exist once rather than per
 *  integration. What varies between providers is the URL and the shape of the
 *  answer; nothing about how failure is handled varies at all. */

export type ProviderError = Error & {
  /** Set when the provider rejected the credential rather than failing. That stops
   *  the retry loop: no number of attempts fixes a revoked key. */
  disconnected?: boolean
  status?: number
}

export const providerError = (
  message: string,
  options: { status?: number; disconnected?: boolean } = {},
): ProviderError => {
  const error = new Error(message) as ProviderError
  if (options.status !== undefined) error.status = options.status
  if (options.disconnected) error.disconnected = true
  return error
}

/** A credential rejection, in the two shapes every provider uses. */
export const isCredentialRejection = (status: number): boolean => status === 401 || status === 403

export type AttemptOptions = {
  ctx: WorkspaceContext
  kind: IntegrationKind
  jobName: string
  payload: Record<string, unknown>
  /** Total tries, not retries. Finite by construction: F6 §1 forbids a loop. */
  attempts?: number
}

const BASE_DELAY_MS = 500

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Exponential backoff with jitter, a ceiling, and a dead letter at the end that
 *  carries the payload and the provider's real error so it can be replayed. */
export const attempt = async <T>(options: AttemptOptions, run: () => Promise<T>): Promise<T> => {
  const total = options.attempts ?? 4
  let last: unknown = null

  for (let n = 1; n <= total; n++) {
    try {
      return await run()
    } catch (cause) {
      last = cause
      // A rejected credential does not improve with waiting. Fail out now so the
      // health state turns red this cycle rather than in twenty minutes.
      if ((cause as ProviderError).disconnected) break
      if (n === total) break
      const base = BASE_DELAY_MS * 2 ** (n - 1)
      await sleep(base + Math.random() * base)
    }
  }

  const error = last instanceof Error ? last : new Error(String(last))
  await recordDeadLetter(options.ctx, {
    jobName: options.jobName,
    payload: options.payload,
    error: error.message,
    attempts: total,
  }).catch(() => {
    // The database is the last place to record this. If it is unreachable too,
    // there is nothing further to do and the throw below still surfaces it.
  })
  throw error
}

export type JsonRequest = {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}

/** One JSON call, with the provider's own error text kept intact. A generic
 *  "request failed" is exactly what F6 §1 forbids: the health panel has to be able
 *  to show what the provider actually said. */
export const json = async <T>(request: JsonRequest): Promise<T> => {
  const response = await fetch(request.url, {
    method: request.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...request.headers,
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    signal: AbortSignal.timeout(request.timeoutMs ?? 15_000),
  })

  const text = await response.text()
  if (!response.ok) {
    throw providerError(`${response.status} ${response.statusText}: ${text.slice(0, 400)}`, {
      status: response.status,
      disconnected: isCredentialRejection(response.status),
    })
  }
  return (text ? JSON.parse(text) : null) as T
}

export type ConnectionTest = { ok: boolean; detail: string }
