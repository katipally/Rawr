import { createMcpToken, listMcpTokens, revokeMcpToken } from '@rawr/db'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.ts'

/** F5 §1. The four things the Settings screen does with agent tokens.
 *
 *  `protectedProcedure` rather than `adminProcedure`: a token is a person's own
 *  access to what they can already reach, so a salesperson creates their own
 *  without asking. Who may revoke which one is finer than a role can say and is
 *  decided in the data access layer. */
export const mcpRouter = router({
  tokens: protectedProcedure.query(({ ctx }) => listMcpTokens(ctx.workspace)),

  /** The plaintext crosses the wire exactly once, here, and is never readable
   *  again. The screen shows it and says so. */
  create: protectedProcedure
    .input(z.object({ name: z.string().min(1).max(80) }))
    .mutation(({ ctx, input }) => createMcpToken(ctx.workspace, input)),

  revoke: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => revokeMcpToken(ctx.workspace, input.id)),
})
