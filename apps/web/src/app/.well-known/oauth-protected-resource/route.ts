import { protectedResourceMetadata } from '~/server/mcp/oauth.ts'

/** RFC 9728. Served at the origin root and, in the sibling route, under the
 *  MCP path, because clients probe the path-specific form first. */
export const GET = async (): Promise<Response> =>
  Response.json(await protectedResourceMetadata(), {
    headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
  })
