import { listDeadLetters, revokeOtherSessions, revokeSession, signOutEverywhere } from '@rawr/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { adminProcedure, protectedProcedure, router } from '../trpc.ts'
import { accountRouter } from './account.ts'
import { adminRouter } from './admin.ts'
import { analyticsRouter } from './analytics.ts'
import { bookingRouter } from './booking.ts'
import { crmRouter } from './crm.ts'
import { formsRouter } from './forms.ts'
import { integrationsRouter } from './integrations.ts'
import { mailRouter } from './mail.ts'
import { mcpRouter } from './mcp.ts'
import { notificationsRouter } from './notifications.ts'
import { preferencesRouter } from './preferences.ts'
import { segmentsRouter } from './segments.ts'
import { reportingRouter } from './reporting.ts'
import { sequencesRouter } from './sequences.ts'

export const appRouter = router({
  admin: adminRouter,
  analytics: analyticsRouter,
  booking: bookingRouter,
  crm: crmRouter,
  forms: formsRouter,
  integrations: integrationsRouter,
  mail: mailRouter,
  mcp: mcpRouter,
  segments: segmentsRouter,
  sequences: sequencesRouter,
  reporting: reportingRouter,

  account: accountRouter,

  session: router({
    /** Ends every session the caller holds. Scoped to the caller by construction:
     *  the id comes from the verified session, never from input. */
    signOutEverywhere: protectedProcedure.mutation(({ ctx }) => signOutEverywhere(ctx.session.userId)),
    /** Ends one of the caller's other sessions. The person comes from the verified
     *  session, so an id that is somebody else's finds nothing to end. */
    revoke: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      if (!(await revokeSession(ctx.session.userId, input.id))) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That session has already ended.' })
      }
    }),
    /** Ends every session the caller holds except this one. */
    revokeOthers: protectedProcedure.mutation(({ ctx }) => revokeOtherSessions(ctx.session.userId, ctx.session.sessionId ?? null)),
  }),

  /** The bell in the top bar and the drawer behind it. */
  notifications: notificationsRouter,

  /** Cross-device settings: bookmarks, recent navigation, a timeline filter, a
   *  collapsed panel, the rail's width. */
  preferences: preferencesRouter,

  jobs: router({
    /** The failed-jobs screen. Replaying is on the integrations router, because a
     *  replay is a provider call and the idempotency key that makes it safe to
     *  press twice lives there. */
    deadLetters: adminProcedure.query(({ ctx }) => listDeadLetters(ctx.account)),
  }),

})

export type AppRouter = typeof appRouter
