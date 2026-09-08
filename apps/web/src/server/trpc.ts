import { ForbiddenError, canEdit, type AccountContext } from '@rawr/db'
import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import { contextFrom, readSession, type Session } from './session.ts'

export type Context = {
  session: Session | null
  account: AccountContext | null
}

export const createContext = async (): Promise<Context> => {
  const session = await readSession()
  return { session, account: session ? contextFrom(session) : null }
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => {
    // A refused grant is a 403 with a sentence a person can act on, never a
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
  if (!ctx.session || !ctx.account) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' })
  }
  return next({ ctx: { ...ctx, session: ctx.session, account: ctx.account } })
})

/** A convenience for surfaces nobody without the account hub can even open. The
 *  data access layer still checks the grant on every write, so this is a second
 *  gate, not the only one. */
export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!canEdit(ctx.account, 'account')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You need account access to open account settings.',
    })
  }
  return next({ ctx })
})

/** Seating somebody, ending their access, changing what the account itself is.
 *  Above the hubs, so holding one is never enough. */
export const superAdminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.session.isSuperAdmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only a super admin can open this. Ask one of them.',
    })
  }
  return next({ ctx })
})
