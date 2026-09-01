import type { NextRequest } from 'next/server'

/** The shared secret between the worker and the app.
 *
 *  Constant time, and the length is compared first because a timing-safe compare
 *  throws on a length mismatch and the length of a secret is not the secret. An
 *  unset secret never matches, so a deployment that forgot to configure one has a
 *  closed endpoint rather than an open one. */
export const internalRequestIsAuthentic = (request: NextRequest, secret: string): boolean => {
  const presented = request.headers.get('x-rawr-internal') ?? ''
  if (!secret || secret.length !== presented.length) return false
  let same = 0
  for (let i = 0; i < secret.length; i++) same |= secret.charCodeAt(i) ^ presented.charCodeAt(i)
  return same === 0
}
