import { authorizationServerMetadata } from '~/server/mcp/oauth.ts'

/** RFC 8414. Rawr is its own authorization server, on the same origin as the
 *  MCP endpoint, whichever origin that turns out to be.
 *
 *  Not cached at the edge: the document names the host it was fetched from, so one
 *  deployment answering on two hostnames must not serve the first one's answer to
 *  the second. Clients cache it themselves for the life of a connection. */
export const GET = async (): Promise<Response> =>
  Response.json(await authorizationServerMetadata(), {
    headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
  })
