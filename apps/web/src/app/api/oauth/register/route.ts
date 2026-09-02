import { saveMcpClient } from '@rawr/db'
import { randomBytes } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { oauthError, redirectAcceptable } from '~/server/mcp/oauth.ts'
import { clientIp, rateLimit } from '~/server/edge.ts'

/** RFC 7591 dynamic client registration. Open, as the RFC allows for public
 *  clients: registering buys nothing but a name on a consent screen that a
 *  person still has to approve. Rate limited so it cannot be used to fill a table. */

export const dynamic = 'force-dynamic'

export const POST = async (request: NextRequest): Promise<Response> => {
  const limit = rateLimit(`oauth-register:${clientIp(request) ?? 'unknown'}`, 30, 60)
  if (!limit.allowed) return oauthError('too_many_requests', 'Try again in a minute.', 429)

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return oauthError('invalid_client_metadata', 'The registration body is not JSON.')
  }

  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : []
  const redirectUris = uris.filter((uri): uri is string => typeof uri === 'string' && redirectAcceptable(uri))
  if (redirectUris.length === 0) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must list at least one https URL or a loopback http URL.')
  }
  const auth = body.token_endpoint_auth_method
  if (auth !== undefined && auth !== 'none') {
    return oauthError('invalid_client_metadata', 'Only public clients are registered here: token_endpoint_auth_method must be "none".')
  }

  const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 120) : 'An MCP client'
  const client = await saveMcpClient({
    id: `rawr_client_${randomBytes(16).toString('base64url')}`,
    name,
    redirectUris,
    source: 'dcr',
  })

  return Response.json(
    {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  )
}
