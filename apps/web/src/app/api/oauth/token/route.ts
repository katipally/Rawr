import { issueOauthToken, redeemOauthCode, refreshOauthToken } from '@rawr/db'
import type { NextRequest } from 'next/server'
import { oauthError, pkceMatches, resolveClient, resource as ourResource } from '~/server/mcp/oauth.ts'
import { clientIp, rateLimit } from '~/server/edge.ts'

/** The token endpoint. Form-encoded in, JSON out, RFC 6749 error codes only:
 *  a client refreshing decides what to do next from `invalid_grant` and from
 *  nothing else. */

export const dynamic = 'force-dynamic'

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' }

export const POST = async (request: NextRequest): Promise<Response> => {
  const limit = rateLimit(`oauth-token:${clientIp(request) ?? 'unknown'}`, 60, 60)
  if (!limit.allowed) return oauthError('too_many_requests', 'Try again in a minute.', 429)

  const type = request.headers.get('content-type') ?? ''
  let form: URLSearchParams
  if (type.includes('application/x-www-form-urlencoded')) {
    form = new URLSearchParams(await request.text())
  } else if (type.includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    form = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))
  } else {
    return oauthError('invalid_request', 'Send application/x-www-form-urlencoded.', 415)
  }

  const clientId = form.get('client_id') ?? ''
  const client = clientId ? await resolveClient(clientId) : null
  if (!client) return oauthError('invalid_client', 'That client_id is not registered.', 401)

  const grant = form.get('grant_type')

  if (grant === 'authorization_code') {
    const code = form.get('code') ?? ''
    const verifier = form.get('code_verifier') ?? ''
    if (!code || !verifier) return oauthError('invalid_request', 'code and code_verifier are both required.')

    const redeemed = await redeemOauthCode(code)
    if (!redeemed) return oauthError('invalid_grant', 'That code is unknown or was already used.')
    if (redeemed.expiresAt.getTime() < Date.now()) return oauthError('invalid_grant', 'That code has expired. Start the connection again.')
    if (redeemed.clientId !== clientId) return oauthError('invalid_grant', 'That code was issued to a different client.')
    const redirectUri = form.get('redirect_uri')
    if (redirectUri && redirectUri !== redeemed.redirectUri) {
      return oauthError('invalid_grant', 'redirect_uri does not match the one the code was issued for.')
    }
    if (!pkceMatches(verifier, redeemed.codeChallenge)) return oauthError('invalid_grant', 'The PKCE verifier does not match.')
    const asked = form.get('resource')
    const ours = await ourResource()
    if (asked && asked !== ours) return oauthError('invalid_target', `Tokens here are for ${ours}.`)

    const issued = await issueOauthToken({
      workspaceId: redeemed.workspaceId,
      userId: redeemed.userId,
      clientId,
      clientName: client.name,
      scope: redeemed.scope,
    })
    return Response.json(
      {
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        refresh_token: issued.refreshToken,
        ...(issued.scope ? { scope: issued.scope } : {}),
      },
      { headers: NO_STORE },
    )
  }

  if (grant === 'refresh_token') {
    const presented = form.get('refresh_token') ?? ''
    if (!presented) return oauthError('invalid_request', 'refresh_token is required.')
    const issued = await refreshOauthToken(presented, clientId)
    if (!issued) return oauthError('invalid_grant', 'That refresh token is no longer valid. Connect again.')
    return Response.json(
      {
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        refresh_token: issued.refreshToken,
        ...(issued.scope ? { scope: issued.scope } : {}),
      },
      { headers: NO_STORE },
    )
  }

  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.')
}
