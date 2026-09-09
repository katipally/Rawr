import { createHash } from 'node:crypto'
import { readMcpClient, saveMcpClient, type McpClientRow } from '@rawr/db'
import { requestOrigin } from '~/server/origin.ts'

/** F5 §1, the OAuth 2.1 half. Rawr is both the resource server (/api/mcp) and the
 *  authorization server, on one origin, so the two discovery documents point at
 *  the same host and a client that reads either finds everything.
 *
 *  Any MCP client can connect; nothing here is written for a particular one.
 *  Clients identify themselves one of two ways, and both are public clients with
 *  PKCE and no secret:
 *    DCR   POST /api/oauth/register, RFC 7591. What a hosted or desktop client does.
 *    CIMD  the client_id is an https URL serving its own metadata. What a
 *          command-line client with no server of its own does.
 *  Both end up as an mcp_client row: a name to show on the consent screen and the
 *  redirect URIs the code may be sent back to. */

export const MCP_PATH = '/api/mcp'

/** Resolved per request rather than at boot, so moving this deployment to another
 *  host needs no configuration: the discovery documents, the endpoints inside them
 *  and the resource identifier all name the origin the client actually reached.
 *  See server/origin.ts for why this differs from `publicBaseUrl`. */
export const issuer = requestOrigin
export const resource = async (): Promise<string> => `${await requestOrigin()}${MCP_PATH}`

/** What a token may do is decided by the person's role, not by scope; one scope
 *  names the whole thing so clients that insist on asking for one have an answer. */
export const SCOPES = ['rawr', 'offline_access'] as const
export const SCOPE_DESCRIPTION = 'Read and change records as you, with your role.'

export const protectedResourceMetadata = async () => {
  const origin = await requestOrigin()
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Rawr CRM',
  }
}

export const authorizationServerMetadata = async () => {
  const origin = await requestOrigin()
  return {
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/api/oauth/token`,
  registration_endpoint: `${origin}/api/oauth/register`,
  scopes_supported: [...SCOPES],
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  }
}

/** The 401 every client understands: where the metadata is, and which scope to
 *  ask for. A 200 carrying WWW-Authenticate is ignored by every client. */
export const challengeHeader = async (): Promise<string> =>
  `Bearer realm="Rawr MCP", resource_metadata="${await requestOrigin()}/.well-known/oauth-protected-resource${MCP_PATH}", scope="rawr"`

// ------------------------------------------------------------------ clients

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

const isLoopback = (uri: string): boolean => {
  try {
    const parsed = new URL(uri)
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

/** Exact match, except that a loopback redirect matches with any port: a native
 *  client binds an ephemeral port per session (RFC 8252 §7.3). */
export const redirectAllowed = (client: McpClientRow, uri: string): boolean => {
  if (client.redirectUris.includes(uri)) return true
  if (!isLoopback(uri)) return false
  const asked = new URL(uri)
  return client.redirectUris.some((registered) => {
    if (!isLoopback(registered)) return false
    const known = new URL(registered)
    return known.hostname === asked.hostname && known.pathname === asked.pathname
  })
}

/** Only https, or http on a loopback address. Anything else lets a registration
 *  turn the authorization code into a phishing hop. */
export const redirectAcceptable = (uri: string): boolean => {
  try {
    const parsed = new URL(uri)
    return parsed.protocol === 'https:' || isLoopback(uri)
  } catch {
    return false
  }
}

const CIMD_TTL_MS = 60 * 60 * 1000

/** A client_id that is an https URL names a Client ID Metadata Document. Fetched
 *  on first sight and re-fetched hourly, so a client that rotates its redirect
 *  list is honoured without a re-registration. */
export const resolveClient = async (clientId: string): Promise<McpClientRow | null> => {
  const cached = await readMcpClient(clientId)
  const isUrl = /^https:\/\//.test(clientId)
  if (!isUrl) return cached
  if (cached?.fetchedAt && Date.now() - cached.fetchedAt.getTime() < CIMD_TTL_MS) return cached

  let document: { client_id?: string; client_name?: string; redirect_uris?: unknown }
  try {
    const response = await fetch(clientId, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`answered ${response.status}`)
    document = (await response.json()) as typeof document
  } catch {
    // A stale copy beats a refusal when the document is briefly unreachable.
    return cached
  }
  if (document.client_id !== clientId) return cached
  const redirectUris = Array.isArray(document.redirect_uris)
    ? document.redirect_uris.filter((uri): uri is string => typeof uri === 'string' && redirectAcceptable(uri))
    : []
  if (redirectUris.length === 0) return cached

  return saveMcpClient({
    id: clientId,
    name: typeof document.client_name === 'string' ? document.client_name.slice(0, 120) : new URL(clientId).hostname,
    redirectUris,
    source: 'cimd',
  })
}

// --------------------------------------------------------------------- PKCE

export const pkceMatches = (verifier: string, challenge: string): boolean => {
  if (verifier.length < 43 || verifier.length > 128) return false
  const digest = createHash('sha256').update(verifier).digest('base64url')
  return digest === challenge
}

// ------------------------------------------------------------------ helpers

/** The one place an OAuth error is shaped, so the client always gets RFC 6749
 *  codes rather than whatever an exception said. */
export const oauthError = (error: string, description: string, status = 400) =>
  Response.json({ error, error_description: description }, { status, headers: { 'cache-control': 'no-store' } })

export type AuthorizeRequest = {
  clientId: string
  redirectUri: string
  state: string | null
  codeChallenge: string
  scope: string | null
  resource: string | null
}

/** A resource identifier with the parts RFC 8707 §2 says it should not carry
 *  removed, so two spellings of this endpoint compare equal. Anything that is not
 *  a URL is returned as it came and fails the comparison it was headed for. */
const canonicalResource = (uri: string | null): string | null => {
  if (!uri) return null
  try {
    const url = new URL(uri)
    url.search = ''
    url.hash = ''
    return url.href.replace(/\/$/, '')
  } catch {
    return uri
  }
}

/** Everything an authorization request has to get right before a consent screen
 *  is worth showing. Returns the reason when it is not. */
export const checkAuthorizeRequest = async (
  params: URLSearchParams,
): Promise<{ ok: true; request: AuthorizeRequest; client: McpClientRow } | { ok: false; problem: string }> => {
  const clientId = params.get('client_id') ?? ''
  if (!clientId) return { ok: false, problem: 'The request names no client_id.' }
  const client = await resolveClient(clientId)
  if (!client) return { ok: false, problem: `No client is registered as ${clientId}. Register it first, or use a client_id that is a metadata URL.` }

  const redirectUri = params.get('redirect_uri') ?? client.redirectUris[0] ?? ''
  if (!redirectAllowed(client, redirectUri)) {
    return { ok: false, problem: `${client.name} is not allowed to send you to ${redirectUri}.` }
  }
  if ((params.get('response_type') ?? 'code') !== 'code') {
    return { ok: false, problem: 'Only response_type=code is supported.' }
  }
  const codeChallenge = params.get('code_challenge') ?? ''
  if (!codeChallenge || (params.get('code_challenge_method') ?? 'S256') !== 'S256') {
    return { ok: false, problem: 'A PKCE code_challenge with method S256 is required.' }
  }
  // RFC 8707. A client that names the resource it wants a token for must name
  // this one, read from the origin it reached rather than from configuration.
  //
  // Compared canonically, because the endpoint address carries a ?toolsets query
  // and a client that echoes back the URL a person pasted is naming this server,
  // not another one. RFC 8707 §2 says the canonical form drops the query anyway.
  const asked = canonicalResource(params.get('resource'))
  const ours = await resource()
  if (asked && asked !== ours) {
    return { ok: false, problem: `This server issues tokens for ${ours}, not ${asked}.` }
  }

  return {
    ok: true,
    client,
    request: {
      clientId,
      redirectUri,
      state: params.get('state'),
      codeChallenge,
      scope: params.get('scope'),
      resource: asked,
    },
  }
}
