/** The tenants the seed builds and the verify suites read.
 *
 *  They are deliberately not a real company. The seed empties its accounts by
 *  slug before rebuilding them, so anything sharing a slug with a fixture is
 *  destroyed on the next `pnpm db:seed`; keeping the fixtures on reserved `.test`
 *  domains is what stops that reaching an account somebody actually uses.
 *
 *  Two of them, because tenancy is only provable against a second tenant. */
export const SANDBOX = { name: 'Sandbox', slug: 'sandbox', domain: 'sandbox.test' } as const
export const PEER = { name: 'Peer Tenant', slug: 'peer', domain: 'peer.test' } as const

/** A seeded seat's address. The local parts are the shapes of access the seed
 *  builds: `admin`, `sales`, `marketing`, `viewer`, `former`. */
export const seat = (who: string): string => `${who}@${SANDBOX.domain}`
