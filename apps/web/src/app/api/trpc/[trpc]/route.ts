import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { appRouter } from '~/server/routers/_app.ts'
import { createContext } from '~/server/trpc.ts'

const handler = (request: Request): Promise<Response> =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    createContext,
  })

export { handler as GET, handler as POST }
