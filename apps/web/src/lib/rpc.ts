'use client'

import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client'
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

/** Every message a procedure throws is written for a person to read, so it is
 *  shown as-is. Anything else is a transport failure and says so. */
export const errorMessage = (cause: unknown): string => {
  if (cause instanceof TRPCClientError) return cause.message
  if (cause instanceof Error) return cause.message
  return 'The server did not answer. Check your connection and try again.'
}

export const errorCode = (cause: unknown): string =>
  cause instanceof TRPCClientError ? ((cause.data as { code?: string } | null)?.code ?? 'UNKNOWN') : 'UNKNOWN'
