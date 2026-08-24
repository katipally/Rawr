import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source, not a build step.
  transpilePackages: ['@rawr/db', '@rawr/ui'],
  typedRoutes: true,
  // This repo already has its own agent instructions; Next should not write more.
  agentRules: false,
}

export default config
