import {
  clampRange,
  createSite,
  eraseContactActivity,
  eventFunnel,
  exportContactActivity,
  FUNNEL_MAX_STEPS,
  FUNNEL_MIN_STEPS,
  listEventDefs,
  saveEventDef,
  setSiteActive,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { adminProcedure, protectedProcedure, router } from '../trpc.ts'

/** F4's surfaces. The two data-subject paths are admin only and enforced in the
 *  data access layer as well, so calling them directly is refused the same way. */
export const analyticsRouter = router({
  sites: router({
    create: adminProcedure
      .input(
        z.object({
          name: z.string().trim().min(1).max(120),
          host: z.string().trim().min(3).max(253),
          siteKey: z.string().trim().min(3).max(61),
        }),
      )
      .mutation(({ ctx, input }) => call(() => createSite(ctx.account, input))),

    setActive: adminProcedure
      .input(z.object({ id: z.uuid(), isActive: z.boolean() }))
      .mutation(({ ctx, input }) =>
        call(() => setSiteActive(ctx.account, input.id, input.isActive)),
      ),
  }),

  /** Item 13. Reading the list is open to anybody signed in, because a funnel is
   *  aggregate numbers about the account's own traffic; describing an event is a
   *  settings act and goes through the data layer's write check. */
  events: router({
    list: protectedProcedure
      .input(
        z.object({
          search: z.string().trim().max(120).nullish(),
          limit: z.number().int().min(1).max(100).optional(),
          offset: z.number().int().min(0).optional(),
        }).optional(),
      )
      .query(({ ctx, input }) => call(() => listEventDefs(ctx.account, input ?? {}))),

    save: protectedProcedure
      .input(
        z.object({
          name: z.string().trim().min(1).max(120),
          label: z.string().trim().max(160).nullish(),
          properties: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .mutation(({ ctx, input }) => call(() => saveEventDef(ctx.account, input))),

    funnel: protectedProcedure
      .input(
        z.object({
          from: z.iso.datetime().optional(),
          to: z.iso.datetime().optional(),
          steps: z.array(z.string().trim().min(1).max(120)).min(FUNNEL_MIN_STEPS).max(FUNNEL_MAX_STEPS),
        }),
      )
      .query(({ ctx, input }) =>
        call(() => eventFunnel(ctx.account, { steps: input.steps, range: clampRange(input) })),
      ),
  }),

  /** One export path per contact, covering page views, events, submissions and
   *  consent records. Built in this feature because this is the feature that
   *  creates the obligation. */
  exportContact: adminProcedure
    .input(z.object({ contactId: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => exportContactActivity(ctx.account, input.contactId))),

  eraseContact: adminProcedure
    .input(z.object({ contactId: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => eraseContactActivity(ctx.account, input.contactId))),
})
