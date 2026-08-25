import {
  createSite,
  eraseContactActivity,
  exportContactActivity,
  listCollectorNotices,
  listSites,
  setSiteActive,
  websiteActivity,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { adminProcedure, protectedProcedure, router } from '../trpc.ts'

/** F4's surfaces. The two data-subject paths are admin only and enforced in the
 *  data access layer as well, so calling them directly is refused the same way. */
export const analyticsRouter = router({
  websiteActivity: protectedProcedure
    .input(z.object({ contactId: z.uuid() }))
    .query(({ ctx, input }) => call(() => websiteActivity(ctx.workspace, input.contactId))),

  sites: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listSites(ctx.workspace))),

    create: adminProcedure
      .input(
        z.object({
          name: z.string().trim().min(1).max(120),
          host: z.string().trim().min(3).max(253),
          siteKey: z.string().trim().min(3).max(61),
        }),
      )
      .mutation(({ ctx, input }) => call(() => createSite(ctx.workspace, input))),

    setActive: adminProcedure
      .input(z.object({ id: z.uuid(), isActive: z.boolean() }))
      .mutation(({ ctx, input }) =>
        call(() => setSiteActive(ctx.workspace, input.id, input.isActive)),
      ),
  }),

  notices: adminProcedure.query(({ ctx }) => call(() => listCollectorNotices(ctx.workspace))),

  /** One export path per contact, covering page views, events, submissions and
   *  consent records. Built in this feature because this is the feature that
   *  creates the obligation. */
  exportContact: adminProcedure
    .input(z.object({ contactId: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => exportContactActivity(ctx.workspace, input.contactId))),

  eraseContact: adminProcedure
    .input(z.object({ contactId: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => eraseContactActivity(ctx.workspace, input.contactId))),
})
