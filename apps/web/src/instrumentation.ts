import type { Instrumentation } from 'next'

/** Runs once when the server starts, and never during a build.
 *
 *  The production secret check lives here for exactly that reason: `next build`
 *  sets NODE_ENV=production and renders pages, so a check at module scope refused
 *  the build on any machine that holds development secrets. A build is not a
 *  boot. What has to be impossible is a server serving requests on dev values. */
export const register = async (): Promise<void> => {
  // The edge runtime imports this too, and the check reads Node-only config.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { assertProductionSecrets } = await import('~/lib/env.ts')
  assertProductionSecrets()
}

/** Next reports what a page, route or action threw, with the digest it already put
 *  on the screen. The account comes from the address because the session cookie
 *  is not readable here, and only the route pattern is logged because an address
 *  can carry a token. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const [{ describe, logError }, { accountInPath }] = await Promise.all([
    import('~/server/log.ts'),
    import('~/lib/links.ts'),
  ])
  logError({
    msg: 'request failed',
    digest: (error as { digest?: string }).digest,
    method: request.method,
    route: context.routePath,
    routeType: context.routeType,
    account: accountInPath(request.path),
    error: describe(error),
  })
}
