// psl ships type definitions but does not publish them through its package exports
// map, so TypeScript cannot resolve them by module name. Typing the surface we use
// here keeps that one problem in one file instead of every consumer's tsconfig.
// @ts-expect-error the runtime module is untyped for the reason above.
import untyped from 'psl'

type Parsed = { domain: string | null; sld: string | null; subdomain: string | null; tld: string | null }
type ParseFailure = { error: { code: string; message: string } }

export const psl = untyped as {
  parse(input: string): Parsed | ParseFailure
}
