/** F5 §1. The stdio half of the transport, for a client that cannot speak HTTP.
 *
 *  Deliberately a bridge and not a second server. The tools, the role checks, the
 *  resolution and the idempotency ledger all live behind the HTTP endpoint; a
 *  parallel implementation here would be a second place for them to drift, and the
 *  first thing to go stale would be a permission check.
 *
 *  So this reads newline-delimited JSON-RPC on stdin, posts each message to
 *  /api/mcp with the token, and writes the answer to stdout. Nothing else. Logs go
 *  to stderr, because stdout carries the protocol and nothing but.
 *
 *    RAWR_MCP_URL=http://localhost:3000/api/mcp \
 *    RAWR_MCP_TOKEN=rawr_mcp_… \
 *    node --experimental-strip-types apps/web/scripts/mcp-stdio.ts
 */

const url = process.env.RAWR_MCP_URL ?? 'http://localhost:3000/api/mcp'
const token = process.env.RAWR_MCP_TOKEN ?? ''

if (!token) {
  process.stderr.write(
    'RAWR_MCP_TOKEN is not set. Create a token under Settings → Agent access and export it.\n',
  )
  process.exit(1)
}

/** A tool call can wait on a database read; nothing here should wait on a hung
 *  connection forever. */
const TIMEOUT_MS = 30_000

const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** stdin can close while answers are still in flight, and exiting then would lose
 *  them. Counted rather than awaited in order, because a client may have several
 *  calls outstanding and they finish when they finish. */
let inFlight = 0
let closed = false

const done = (): void => {
  inFlight--
  if (closed && inFlight === 0) process.exit(0)
}

const forward = async (line: string): Promise<void> => {
  let id: unknown = null
  try {
    id = (JSON.parse(line) as { id?: unknown }).id ?? null
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'That line is not JSON.' } })
    return
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: line,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    // A notification is answered 202 with no body, and has no id to reply to.
    if (response.status === 202) return

    const text = await response.text()
    if (!text) {
      if (id !== null) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: `Rawr answered ${response.status} with no body.` },
        })
      }
      return
    }
    process.stdout.write(`${text.trim()}\n`)
  } catch (cause) {
    // Answered as a JSON-RPC error rather than thrown, so the client sees a reason
    // instead of a bridge that stopped replying.
    if (id === null) return
    send({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: `Could not reach Rawr at ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
    })
  }
}

/** Messages are newline-delimited and must not contain embedded newlines, so a
 *  buffer split on \n is the whole framing. A partial line is held until the rest
 *  arrives rather than parsed and rejected. */
let buffer = ''
process.stdin.setEncoding('utf8')

process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      inFlight++
      void forward(line).finally(done)
    }
    index = buffer.indexOf('\n')
  }
})

process.stdin.on('end', () => {
  closed = true
  if (inFlight === 0) process.exit(0)
})
