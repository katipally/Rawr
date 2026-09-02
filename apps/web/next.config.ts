import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source, not a build step.
  transpilePackages: ['@rawr/db', '@rawr/ui'],
  // Every address is built in ~/lib/links.ts, which is the typed layer. Typed
  // routes would demand a cast at each of the hundred places those strings land.
  typedRoutes: false,
  // This repo already has its own agent instructions; Next should not write more.
  agentRules: false,
}

export default config
