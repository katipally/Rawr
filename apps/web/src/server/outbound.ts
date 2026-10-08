import { lookup as resolveName } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { checkOutboundUrl, refusedAddress } from '@rawr/db'

/** The one way Rawr calls an address somebody else chose: a webhook endpoint, an
 *  automation step, a pasted integration URL, a client's metadata document.
 *
 *  `fetch` is not used because it follows redirects and offers no hook between
 *  resolving a name and connecting to it. A name that answers with a public
 *  address when it is saved and a private one when it is called gets through any
 *  check made beforehand. Here the check is the socket's own `lookup`, so the
 *  address that was judged is the address that is connected to, and a redirect is
 *  an answer to read rather than a place to go.
 *
 *  Errors say the host and never the path or query, because those carry tokens
 *  and these messages end up in run logs and the Failed jobs screen. */

export type OutboundRequest = {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: string | undefined
  /** For the whole exchange, body included, so a receiver that answers one byte a
   *  second cannot hold a socket for the length of its patience. */
  timeoutMs: number
  maxBytes: number
}

export type OutboundResponse = {
  status: number
  statusText: string
  ok: boolean
  retryAfter: string | null
  /** At most `maxBytes`. Whoever needs the whole answer reads `truncated`. */
  text: string
  truncated: boolean
}

type Resolve = (host: string) => Promise<{ address: string; family: number }[]>

const system: Resolve = (host) => resolveName(host, { all: true, verbatim: true })

class Refused extends Error {}

/** Every address the name has must be allowed, not just the first: the connection
 *  may try any of them, and one private record among public ones is the attack. */
const guardedLookup =
  (resolve: Resolve, host: string): LookupFunction =>
  (name, options, callback) => {
    resolve(name).then(
      (found) => {
        const first = found[0]
        if (!first || found.some(({ address }) => refusedAddress(address))) {
          callback(new Refused(`${host} resolves to a private address, which Rawr does not call.`), '', 0)
        } else if (options.all) {
          callback(null, found)
        } else {
          callback(null, first.address, first.family)
        }
      },
      (cause: NodeJS.ErrnoException) => callback(cause, '', 0),
    )
  }

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return 'that address'
  }
}

/** A plain sentence for a transport failure. The cause's own text is never shown:
 *  it names internal addresses and ports, and the code is what says what happened. */
export const reachFailure = (host: string, cause: unknown): string => {
  const error = cause as { code?: unknown; cause?: { code?: unknown } } | null
  const id = [error?.code, error?.cause?.code].find((value): value is string => typeof value === 'string') ?? ''
  if (id === 'ECONNREFUSED') return `${host} refused the connection.`
  if (id === 'ENOTFOUND' || id === 'EAI_AGAIN') return `${host} was not found (DNS).`
  if (id === 'ETIMEDOUT' || id === 'UND_ERR_CONNECT_TIMEOUT' || id === 'ESOCKETTIMEDOUT') {
    return `${host} did not answer in time.`
  }
  if (id === 'ECONNRESET' || id === 'EPIPE') return `the connection to ${host} was reset.`
  if (id.includes('CERT') || id === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return `the certificate of ${host} could not be verified.`
  }
  return `${host} could not be reached.`
}

/** `resolve` is only there so a test can say what a name resolves to. */
export const outboundRequest = (request: OutboundRequest, resolve: Resolve = system): Promise<OutboundResponse> => {
  let url: URL
  try {
    url = new URL(request.url.trim())
  } catch {
    return Promise.reject(new Error('The address is not a URL.'))
  }
  const host = url.host
  try {
    // An IP literal never reaches `lookup`, so it is judged here.
    checkOutboundUrl(url.href)
  } catch (cause) {
    return Promise.reject(cause)
  }

  const payload = request.body === undefined ? undefined : Buffer.from(request.body)
  return new Promise((settle, reject) => {
    const fail = (error: Error) => {
      clearTimeout(timer)
      reject(error)
      req.destroy()
    }
    const timer = setTimeout(
      () => fail(new Error(`${host} did not answer within ${Math.ceil(request.timeoutMs / 1000)} seconds.`)),
      request.timeoutMs,
    )

    const req = (url.protocol === 'https:' ? https : http).request(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method ?? 'GET',
        headers: { ...request.headers, ...(payload ? { 'content-length': String(payload.length) } : {}) },
        agent: false,
        lookup: guardedLookup(resolve, host),
      },
      (response) => {
        const chunks: Buffer[] = []
        let kept = 0
        const finish = (truncated: boolean) => {
          clearTimeout(timer)
          const status = response.statusCode ?? 0
          settle({
            status,
            statusText: response.statusMessage ?? '',
            ok: status >= 200 && status < 300,
            retryAfter: response.headers['retry-after'] ?? null,
            text: Buffer.concat(chunks).toString('utf8'),
            truncated,
          })
        }
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk.subarray(0, request.maxBytes - kept))
          kept += chunk.length
          if (kept > request.maxBytes) {
            finish(true)
            response.destroy()
          }
        })
        response.on('end', () => finish(false))
        response.on('error', (cause) => fail(new Error(reachFailure(host, cause))))
        response.on('close', () => fail(new Error(`${host} closed the connection before it finished answering.`)))
      },
    )
    req.on('error', (cause) =>
      fail(cause instanceof Refused ? cause : new Error(reachFailure(host, cause))),
    )
    req.end(payload)
  })
}
