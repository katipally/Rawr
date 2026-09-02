import { authorizationServerMetadata } from '~/server/mcp/oauth.ts'

/** RFC 8414. Rawr is its own authorization server, on the same origin as the
 *  MCP endpoint. */
export const GET = (): Response =>
  Response.json(authorizationServerMetadata(), {
    headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' },
  })
