'use client'

import { QueryClient } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import superjson from 'superjson'
import type { AppRouter } from '~/server/routers/_app.ts'

/** The typed client the interactive surfaces call. Server components read through
 *  the data access layer directly, so this carries the mutations and the handful
 *  of reads that happen after a click.
 *
 *  Every request names the account this tab is showing, read from the shell. The
 *  session cookie is shared by every tab, so a tab that is still on one account
 *  would otherwise write into whichever the cookie was moved to since; the server
 *  refuses the request instead. */
export const api = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/api/trpc',
      transformer: superjson,
      headers: () => {
        const account = document.querySelector('[data-account]')?.getAttribute('data-account')
        return account ? { 'x-rawr-account': account } : {}
      },
    }),
  ],
})

const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        // Short enough that a screen opened again is not a stale one, long enough
        // that a palette, a preview and a sidebar asking for the same lookups in
        // one breath share one request.
        staleTime: 30_000,
        // An answer from the server ("not allowed", "not found") will not change on
        // a second ask; only a failure to reach it is worth trying again.
        retry: (failures, cause) => failures < 2 && !(cause instanceof TRPCClientError && cause.data),
      },
    },
  })

let browserQueryClient: QueryClient | undefined

/** One cache per tab. On the server every render gets its own, so one person's
 *  answers cannot be handed to another; nothing is fetched there anyway. */
export const getQueryClient = (): QueryClient => {
  if (typeof window === 'undefined') return makeQueryClient()
  browserQueryClient ??= makeQueryClient()
  return browserQueryClient
}

/** Reads through the cache: `useQuery(trpc.crm.lookups.queryOptions())`. After a
 *  write, `getQueryClient().invalidateQueries(trpc.crm.lookups.queryFilter())`
 *  refetches only the readers of that procedure, where `router.refresh()` would
 *  re-render the whole page. */
export const trpc = createTRPCOptionsProxy<AppRouter>({ client: api, queryClient: getQueryClient })

/** Every message a procedure throws is written for a person to read, so it is
 *  shown as-is. Anything else is a transport failure and says so. */
export const errorMessage = (cause: unknown): string => {
  if (cause instanceof TRPCClientError) return cause.message
  if (cause instanceof Error) return cause.message
  return 'The server did not answer. Check your connection and try again.'
}

export const errorCode = (cause: unknown): string =>
  cause instanceof TRPCClientError ? ((cause.data as { code?: string } | null)?.code ?? 'UNKNOWN') : 'UNKNOWN'
