import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { digestOf } from '~/server/errors.ts'
import { describe, logError } from '~/server/log.ts'
import { appRouter } from '~/server/routers/_app.ts'
import { createContext } from '~/server/trpc.ts'

const handler = (request: Request): Promise<Response> =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    createContext,
    // A refusal is the person's to read and is not logged. A fault is the
    // server's, and the reference in the response is how it is found here.
    onError: ({ error, path, type, ctx }) => {
      if (error.code !== 'INTERNAL_SERVER_ERROR') return
      logError({
        msg: 'procedure failed',
        digest: digestOf(error),
        procedure: path,
        type,
        accountId: ctx?.session?.accountId,
        userId: ctx?.session?.userId,
        error: describe(error.cause ?? error),
      })
    },
  })

export { handler as GET, handler as POST }
