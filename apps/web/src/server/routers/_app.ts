import { listDeadLetters, signOutEverywhere } from '@rawr/db'
import { adminProcedure, protectedProcedure, publicProcedure, router } from '../trpc.ts'
import { call } from '../errors.ts'
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

  health: publicProcedure.query(() => ({ ok: true as const })),

  me: protectedProcedure.query(({ ctx }) => ({
    email: ctx.session.email,
    displayName: ctx.session.displayName,
    isSuperAdmin: ctx.session.isSuperAdmin,
    viewHubs: ctx.session.viewHubs,
    editHubs: ctx.session.editHubs,
    accountName: ctx.session.accountName,
  })),

  account: accountRouter,

  session: router({
    /** Ends every session the caller holds. Scoped to the caller by construction:
     *  the id comes from the verified session, never from input. */
    signOutEverywhere: protectedProcedure.mutation(({ ctx }) => signOutEverywhere(ctx.session.userId)),
  }),

  /** The bell in the top bar and the drawer behind it. */
  notifications: notificationsRouter,

  jobs: router({
    /** The failed-jobs screen. Replaying is on the integrations router, because a
     *  replay is a provider call and the idempotency key that makes it safe to
     *  press twice lives there. */
    deadLetters: adminProcedure.query(({ ctx }) => listDeadLetters(ctx.account)),
  }),

})

export type AppRouter = typeof appRouter
