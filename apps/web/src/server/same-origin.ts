import { env } from '~/lib/env.ts'

/** True when a browser says the request came from another site. A request with no
 *  Origin header (curl, server to server) is not a browser cross-site post and
 *  passes; a sandboxed frame sends the literal "null", which does not match and
 *  is refused. */
export const crossOrigin = (
  request: Request,
  own: string = new URL(env.AUTH_URL).origin,
): boolean => {
  const origin = request.headers.get('origin')
  return Boolean(origin) && origin !== own
}
