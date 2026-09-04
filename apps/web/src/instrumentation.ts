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
