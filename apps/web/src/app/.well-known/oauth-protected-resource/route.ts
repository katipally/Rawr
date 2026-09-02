import { protectedResourceMetadata } from '~/server/mcp/oauth.ts'

/** RFC 9728. Served at the origin root and, in the sibling route, under the
 *  MCP path, because clients probe the path-specific form first. */
export const GET = (): Response =>
  Response.json(protectedResourceMetadata(), {
    headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' },
  })
