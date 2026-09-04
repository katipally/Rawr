import { listDeadLetters, readNotifications, signOutEverywhere } from '@rawr/db'
import { adminProcedure, protectedProcedure, publicProcedure, router } from '../trpc.ts'
import { call } from '../errors.ts'
import { adminRouter } from './admin.ts'
import { analyticsRouter } from './analytics.ts'
import { bookingRouter } from './booking.ts'
import { crmRouter } from './crm.ts'
import { formsRouter } from './forms.ts'
import { integrationsRouter } from './integrations.ts'
import { mailRouter } from './mail.ts'
import { mcpRouter } from './mcp.ts'
import { orgRouter } from './org.ts'
import { segmentsRouter } from './segments.ts'

export const appRouter = router({
  admin: adminRouter,
  analytics: analyticsRouter,
  booking: bookingRouter,
  crm: crmRouter,
  forms: formsRouter,
  integrations: integrationsRouter,
  mail: mailRouter,
  mcp: mcpRouter,
  org: orgRouter,
  segments: segmentsRouter,

  health: publicProcedure.query(() => ({ ok: true as const })),

  me: protectedProcedure.query(({ ctx }) => ({
    email: ctx.session.email,
    displayName: ctx.session.displayName,
    role: ctx.session.role,
    workspaceName: ctx.session.workspaceName,
  })),

  account: router({
    /** Ends every session the caller holds. Scoped to the caller by construction:
     *  the id comes from the verified session, never from input. */
    signOutEverywhere: protectedProcedure.mutation(({ ctx }) => signOutEverywhere(ctx.session.userId)),
  }),

  /** The bell in the top bar. Read on every page, so it is one query and it
   *  answers for the caller's own role: a viewer never learns that a job failed. */
  notifications: router({
    summary: protectedProcedure.query(({ ctx }) => call(() => readNotifications(ctx.workspace))),
  }),

  jobs: router({
    /** The failed-jobs screen. Replaying is on the integrations router, because a
     *  replay is a provider call and the idempotency key that makes it safe to
     *  press twice lives there. */
    deadLetters: adminProcedure.query(({ ctx }) => listDeadLetters(ctx.workspace)),
  }),

})

export type AppRouter = typeof appRouter
