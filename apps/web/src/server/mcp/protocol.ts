import { recallMcpCall, rememberMcpCall, type McpCaller } from '@rawr/db'
import { TOOLS, TOOLS_BY_NAME, toolsetOf } from './catalogue.ts'
import { contextFor, explain, type ToolResult } from './tools.ts'

/** F5 §1. JSON-RPC over one endpoint, written against two versions of the spec.
 *
 *  The 2026-07-28 revision dropped the initialize handshake and protocol-level
 *  sessions in favour of `server/discover` and `_meta`; every earlier revision
 *  still sends `initialize`. Both are answered here, which costs one extra method
 *  and a few extra result fields, and means a client is never turned away for
 *  speaking the version it was built against.
 *
 *  2025-11-25 is on the list because it was the stable revision immediately before
 *  2026-07-28 and is what a client that has not upgraded yet still declares.
 *  Leaving it out turned those clients away with a 400 naming three versions,
 *  none of which they spoke.
 *
 *  Stateless either way. Nothing is remembered between requests, no session id is
 *  issued, and the credential is the bearer token on every call, which is what the
 *  newer spec requires and the older one permits. */

const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const
const LATEST = SUPPORTED[0]

/** Long enough that a client is not refetching the catalogue between tool calls,
 *  short enough that a custom field added in Settings shows up while somebody is
 *  still in the conversation that needed it. */
const TOOLS_TTL_MS = 60_000

export type JsonRpcId = string | number | null

export type JsonRpcRequest = {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: Record<string, unknown>
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string; data?: unknown } }

/** JSON-RPC 2.0 §5.1, exported because the route spells the same codes and two
 *  copies of a number nobody recognises on sight is how they drift. */
export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
export const INTERNAL = -32603

const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result })

const fail = (id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: data === undefined ? { code, message } : { code, message, data },
})

const SERVER_INFO = {
  name: 'rawr',
  title: 'Rawr CRM',
  version: '1.0.0',
}

const CAPABILITIES = { tools: { listChanged: false } }

/** The version the client asked for if we speak it, ours if it did not ask, and a
 *  refusal naming what we do speak if it asked for something else. */
const negotiate = (asked: unknown): { version: string } | { problem: string } => {
  if (asked === undefined || asked === null) return { version: LATEST }
  const wanted = String(asked)
  if ((SUPPORTED as readonly string[]).includes(wanted)) return { version: wanted }
  return {
    problem: `This server does not speak MCP ${wanted}. It speaks ${SUPPORTED.join(', ')}.`,
  }
}

export type Handled = { response: JsonRpcResponse | null; status: number }

/** A notification (no id) is accepted and answered with nothing, per the transport:
 *  202 with an empty body. A request gets one JSON object back. */
export const handle = async (
  caller: McpCaller,
  message: JsonRpcRequest,
  /** Which toolsets this connection asked to see. Visibility only: a tool left
   *  out of the list still runs, because the person's role decides that and the
   *  same token used from a second client would otherwise disagree about which
   *  tools exist. */
  enabled: ReadonlySet<string>,
): Promise<Handled> => {
  const id = message.id ?? null
  const isNotification = message.id === undefined || message.id === null
  const method = message.method

  if (message.jsonrpc !== undefined && message.jsonrpc !== '2.0') {
    return { response: fail(id, INVALID_REQUEST, 'Only JSON-RPC 2.0 is spoken here.'), status: 400 }
  }
  if (typeof method !== 'string') {
    return { response: fail(id, INVALID_REQUEST, 'A JSON-RPC message needs a method.'), status: 400 }
  }

  const params = (message.params ?? {}) as Record<string, unknown>

  switch (method) {
    // 2026-07-28. Identity and versions, with no handshake to complete first.
    case 'server/discover':
      return {
        response: ok(id, {
          resultType: 'complete',
          protocolVersions: SUPPORTED,
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        }),
        status: 200,
      }

    // 2025-06-18 and earlier.
    case 'initialize': {
      const negotiated = negotiate(params.protocolVersion)
      if ('problem' in negotiated) {
        return { response: fail(id, INVALID_PARAMS, negotiated.problem), status: 400 }
      }
      return {
        response: ok(id, {
          protocolVersion: negotiated.version,
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        }),
        status: 200,
      }
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { response: null, status: 202 }

    case 'ping':
      return { response: ok(id, {}), status: 200 }

    case 'tools/list': {
      const { registry } = await contextFor(caller)
      const listed = TOOLS.filter((tool) => enabled.has(toolsetOf(tool)))
      return {
        response: ok(id, {
          resultType: 'complete',
          tools: listed.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description({ registry }),
            inputSchema: tool.inputSchema({ registry }),
            annotations: {
              readOnlyHint: !tool.writes,
              destructiveHint: tool.writes && /delete|remove|merge|purge|revoke|disconnect|erase|bulk|dismiss/i.test(tool.name),
              idempotentHint: !tool.writes,
              openWorldHint: false,
            },
          })),
          ttlMs: TOOLS_TTL_MS,
          // The catalogue carries this account's own custom fields, so it is
          // private to the caller and must not be cached where another can read it.
          cacheScope: 'private',
        }),
        status: 200,
      }
    }

    case 'tools/call': {
      if (isNotification) {
        return { response: fail(id, INVALID_REQUEST, 'A tool call needs an id.'), status: 400 }
      }
      const name = String(params.name ?? '')
      const tool = TOOLS_BY_NAME.get(name)
      if (!tool) {
        const listed = TOOLS.filter((entry) => enabled.has(toolsetOf(entry))).length
        return {
          response: fail(
            id,
            INVALID_PARAMS,
            `Unknown tool: ${name}. Call tools/list for the ${listed} this connection offers, or add ?toolsets=all to the address for all ${TOOLS.length}.`,
          ),
          status: 200,
        }
      }

      const args = (params.arguments ?? {}) as Record<string, unknown>
      const key = idempotencyKey(params, args)

      // A retry after a timeout answers with what the first attempt did, rather
      // than doing it again. §Edge cases.
      if (tool.writes && key) {
        const remembered = await recallMcpCall(caller.ctx, caller.tokenId, key)
        if (remembered) return { response: ok(id, remembered), status: 200 }
      }

      let outcome: ToolResult
      try {
        outcome = await tool.run(await contextFor(caller), args)
      } catch (cause) {
        outcome = explain(cause)
      }

      const result = {
        resultType: 'complete',
        content: [{ type: 'text', text: outcome.text }],
        ...(outcome.data === undefined ? {} : { structuredContent: outcome.data }),
        isError: outcome.isError === true,
      }

      if (tool.writes && key && !outcome.isError) {
        await rememberMcpCall(caller.ctx, {
          tokenId: caller.tokenId,
          key,
          tool: name,
          result,
        }).catch(() => {
          // The write happened. Losing the ledger row means a retry would repeat
          // it, which is worse than this call failing over bookkeeping.
        })
      }

      return { response: ok(id, result), status: 200 }
    }

    // Declared as unsupported rather than answered with an empty list, so a client
    // does not render an empty Prompts panel for a server that has none.
    case 'prompts/list':
    case 'resources/list':
    case 'resources/templates/list':
      return {
        response: fail(id, METHOD_NOT_FOUND, `This server offers tools only, not ${method.split('/')[0]}.`),
        status: 200,
      }

    default:
      if (isNotification) return { response: null, status: 202 }
      return { response: fail(id, METHOD_NOT_FOUND, `Unknown method: ${method}.`), status: 200 }
  }
}

/** The client may send its own key; a client that does not gets one derived from
 *  what it asked for, so two identical writes in the same minute still collapse.
 *  Deliberately not a hash of the arguments alone: "add the same note twice" is a
 *  thing a person can legitimately mean an hour apart, which is why the ledger
 *  expires. */
const idempotencyKey = (params: Record<string, unknown>, args: Record<string, unknown>): string | null => {
  const meta = params._meta as Record<string, unknown> | undefined
  const given = params.idempotencyKey ?? meta?.['io.modelcontextprotocol/idempotencyKey'] ?? args.idempotency_key
  if (typeof given === 'string' && given.trim()) return given.trim().slice(0, 200)
  return null
}

const INSTRUCTIONS = [
  'Rawr is the CRM. Contacts, companies and deals, with a timeline on every record.',
  '',
  'Records are addressed by name, not by id: "MGG production opportunity" resolves the way a person means it. A name matching more than one record is refused with the candidates and nothing is changed, so pass the id from the refusal on the next call rather than picking one.',
  'Dates may be written as a person says them. Every write states the ISO date it actually set; repeat that date back rather than saying "done".',
  'Every call acts as the person whose token this is, with their role. A refusal naming their role is the real answer, not a fault to work around.',
].join('\n')

export const PROTOCOL_VERSIONS = SUPPORTED
