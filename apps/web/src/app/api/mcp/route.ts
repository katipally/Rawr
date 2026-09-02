import { callerForToken, touchMcpToken } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { handle, PROTOCOL_VERSIONS, type JsonRpcRequest } from '~/server/mcp/protocol.ts'
import { clientIp, rateLimit } from '~/server/edge.ts'
import { challengeHeader } from '~/server/mcp/oauth.ts'

/** F5 §1. The MCP endpoint. One path, POST for messages, and nothing else.
 *
 *  No SSE stream: every tool here answers in one round trip, so a stream would be a
 *  second code path with no second behaviour behind it. A GET is answered 405,
 *  which the transport explicitly allows and which clients handle.
 *
 *  Stateless. No session id is issued or required, so a request carries everything
 *  it needs: the bearer token is the credential and is re-checked on every call,
 *  which is what makes revocation immediate rather than eventual. */

export const dynamic = 'force-dynamic'

/** Requests come from an agent, not a browser, and one conversation can fire a
 *  dozen calls in a burst. Generous per minute, hard enough that a loop stops. */
const PER_MINUTE = 120

/** A tool result carrying a hundred rows is a few kilobytes; a megabyte of
 *  arguments is a mistake or an attack. §Edge cases, "an agent sends 500 fields". */
const MAX_BODY_BYTES = 256 * 1024

const unauthorized = (message: string): NextResponse =>
  NextResponse.json(
    { jsonrpc: '2.0', id: null, error: { code: -32001, message } },
    {
      status: 401,
      // Where the OAuth metadata is, so a client connects by signing in rather
      // than by reading a bare 401; a person holding a stale token reads the message.
      headers: { 'www-authenticate': challengeHeader() },
    },
  )

export const GET = (): NextResponse =>
  NextResponse.json(
    { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'This endpoint answers POST only.' } },
    { status: 405, headers: { allow: 'POST' } },
  )

export const DELETE = GET

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  // The transport requires the client to declare which protocol it is speaking on
  // every request after the handshake. An unknown one is a 400 rather than a guess,
  // because answering in a shape the client cannot read is worse than saying no.
  const declared = request.headers.get('mcp-protocol-version')
  if (declared && !PROTOCOL_VERSIONS.includes(declared as (typeof PROTOCOL_VERSIONS)[number])) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: `This server does not speak MCP ${declared}. It speaks ${PROTOCOL_VERSIONS.join(', ')}.`,
        },
      },
      { status: 400 },
    )
  }

  const authorization = request.headers.get('authorization') ?? ''
  const token = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : ''
  if (!token) {
    return unauthorized('This endpoint needs a Rawr token. Connect through OAuth (sign in when your client asks), or create a token in Settings and send it as "Authorization: Bearer rawr_mcp_…".')
  }

  const caller = await callerForToken(token)
  if (!caller) {
    // One message for wrong, revoked and never-existed alike: which of the three it
    // is would tell somebody probing whether they had guessed a real prefix.
    return unauthorized('That token is not valid. It may have been revoked; create a new one in Settings.')
  }

  const limit = rateLimit(`mcp:${caller.tokenId}`, PER_MINUTE, 60)
  if (!limit.allowed) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message: `Too many calls from this token. Try again in ${limit.retryAfterSeconds} seconds.`,
        },
      },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    )
  }

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: `That request is ${Math.round(raw.length / 1024)}KB; ${MAX_BODY_BYTES / 1024}KB is the limit.` },
      },
      { status: 413 },
    )
  }

  let message: JsonRpcRequest
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      // Batching was removed from the protocol and no current client sends it.
      return NextResponse.json(
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send one JSON-RPC message per request.' } },
        { status: 400 },
      )
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    message = parsed as JsonRpcRequest
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'That request body is not JSON.' } },
      { status: 400 },
    )
  }

  touchMcpToken(caller.tokenId)

  try {
    const handled = await handle(caller, message)
    if (!handled.response) return new NextResponse(null, { status: handled.status })
    return NextResponse.json(handled.response, { status: handled.status })
  } catch (cause) {
    // The real reason, not "something went wrong": the person reading this is
    // holding a terminal and can act on it. 03-build-order, FAILING.
    console.error('[mcp]', clientIp(request) ?? 'unknown', cause)
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code: -32603, message: cause instanceof Error ? cause.message : String(cause) },
      },
      { status: 200 },
    )
  }
}
