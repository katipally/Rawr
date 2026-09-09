import { callerForToken, touchMcpToken } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import {
  handle,
  INTERNAL,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  PROTOCOL_VERSIONS,
  type JsonRpcRequest,
} from '~/server/mcp/protocol.ts'
import { byteLength, clientIp, rateLimit } from '~/server/edge.ts'
import { challengeHeader } from '~/server/mcp/oauth.ts'
import { parseToolsets } from '~/server/mcp/toolsets.ts'

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

/** JSON-RPC leaves -32000 to -32099 to the server. These two are this endpoint's:
 *  one for a credential it will not accept, one for a caller going too fast. */
const UNAUTHORIZED = -32001
const RATE_LIMITED = -32000

/** Requests come from an agent, not a browser, and one conversation can fire a
 *  dozen calls in a burst. Generous per minute, hard enough that a loop stops. */
const PER_MINUTE = 120

/** A tool result carrying a hundred rows is a few kilobytes; a megabyte of
 *  arguments is a mistake or an attack. §Edge cases, "an agent sends 500 fields". */
const MAX_BODY_BYTES = 256 * 1024

const unauthorized = async (message: string): Promise<NextResponse> =>
  NextResponse.json(
    { jsonrpc: '2.0', id: null, error: { code: UNAUTHORIZED, message } },
    {
      status: 401,
      // Where the OAuth metadata is, so a client connects by signing in rather
      // than by reading a bare 401; a person holding a stale token reads the message.
      headers: { 'www-authenticate': await challengeHeader() },
    },
  )

export const GET = (): NextResponse =>
  NextResponse.json(
    { jsonrpc: '2.0', id: null, error: { code: METHOD_NOT_FOUND, message: 'This endpoint answers POST only.' } },
    { status: 405, headers: { allow: 'POST' } },
  )

export const DELETE = GET

/** 2026-07-28 asks a client to repeat the JSON-RPC method, and the tool name for a
 *  tools/call, in headers, so a gateway or a rate limiter can route and meter on
 *  them without parsing a body. They are a hint and never the authority: what runs
 *  is what the body says. Mismatched, they are worth refusing rather than obeying,
 *  because anything in front of us metered the request as something it was not.
 *
 *  Absent is fine. Every client before this revision omits them. */
const headerRoutingDisagrees = (
  request: NextRequest,
  message: JsonRpcRequest,
): string | null => {
  const method = request.headers.get('mcp-method')
  if (method && method !== message.method) {
    return `The Mcp-Method header says "${method}" and the body says "${message.method ?? 'nothing'}".`
  }
  if (message.method !== 'tools/call') return null
  const name = request.headers.get('mcp-name')
  const called = typeof message.params?.name === 'string' ? message.params.name : null
  if (name && name !== called) {
    return `The Mcp-Name header says "${name}" and the call names "${called ?? 'nothing'}".`
  }
  return null
}

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
          code: INVALID_REQUEST,
          message: `This server does not speak MCP ${declared}. It speaks ${PROTOCOL_VERSIONS.join(', ')}.`,
        },
      },
      { status: 400 },
    )
  }

  const authorization = request.headers.get('authorization') ?? ''
  const token = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : ''
  if (!token) {
    return await unauthorized('This endpoint needs a Rawr token. Connect through OAuth (sign in when your client asks), or create a token in Settings and send it as "Authorization: Bearer rawr_mcp_…".')
  }

  const caller = await callerForToken(token)
  if (!caller) {
    // One message for wrong, revoked and never-existed alike: which of the three it
    // is would tell somebody probing whether they had guessed a real prefix.
    return await unauthorized('That token is not valid. It may have been revoked; create a new one in Settings.')
  }

  const limit = rateLimit(`mcp:${caller.tokenId}`, PER_MINUTE, 60)
  if (!limit.allowed) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: RATE_LIMITED,
          message: `Too many calls from this token. Try again in ${limit.retryAfterSeconds} seconds.`,
        },
      },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    )
  }

  const raw = await request.text()
  const size = byteLength(raw)
  if (size > MAX_BODY_BYTES) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: INVALID_REQUEST, message: `That request is ${Math.round(size / 1024)}KB; ${MAX_BODY_BYTES / 1024}KB is the limit.` },
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
        { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Send one JSON-RPC message per request.' } },
        { status: 400 },
      )
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    message = parsed as JsonRpcRequest
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'That request body is not JSON.' } },
      { status: 400 },
    )
  }

  const disagreement = headerRoutingDisagrees(request, message)
  if (disagreement) {
    return NextResponse.json(
      { jsonrpc: '2.0', id: message.id ?? null, error: { code: INVALID_REQUEST, message: disagreement } },
      { status: 400 },
    )
  }

  touchMcpToken(caller.tokenId)

  try {
    // Which tools this connection lists. On the address rather than on the
    // token, so one person's two clients can differ and neither needs a new
    // credential to change its mind.
    const handled = await handle(caller, message, parseToolsets(request.nextUrl.searchParams.get('toolsets')))
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
        error: { code: INTERNAL, message: cause instanceof Error ? cause.message : String(cause) },
      },
      { status: 200 },
    )
  }
}
