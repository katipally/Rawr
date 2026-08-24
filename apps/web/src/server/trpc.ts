import { ForbiddenError, type WorkspaceContext } from '@rawr/db'
import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import { contextFrom, readSession, type Session } from './session.ts'

export type Context = {
  session: Session | null
  workspace: WorkspaceContext | null
}

export const createContext = async (): Promise<Context> => {
  const session = await readSession()
  return { session, workspace: session ? contextFrom(session) : null }
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => {
    // A role refusal is a 403 with a sentence a person can act on, never a
    // generic failure. 03-build-order, FAILING.
    if (error.cause instanceof ForbiddenError) {
      return { ...shape, message: error.cause.message, data: { ...shape.data, code: 'FORBIDDEN' } }
    }
    return shape
  },
})

export const router = t.router
export const publicProcedure = t.procedure

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session || !ctx.workspace) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' })
  }
  return next({ ctx: { ...ctx, session: ctx.session, workspace: ctx.workspace } })
})

/** A convenience for surfaces that only an admin can even open. The data access
 *  layer still checks the role on every write, so this is a second gate, not the
 *  only one. */
export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.session.role !== 'admin') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `Your role (${ctx.session.role}) cannot open workspace settings.`,
    })
  }
  return next({ ctx })
})
