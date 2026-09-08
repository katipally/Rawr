import {
  attributionReport,
  clampRange,
  deleteReportDashboard,
  listReportDashboards,
  readReportDashboard,
  saveReportDashboard,
  emailReport,
  formsReport,
  pipelineReport,
  sequencesReport,
  websiteReport,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { protectedProcedure, router } from '../trpc.ts'

/** B7. Six questions, one shape.
 *
 *  Readable by anybody signed in, viewers included: a report is aggregate numbers
 *  about the account's own work, and the records behind them are already visible
 *  to a viewer one at a time. Nothing here reaches across tenants, because every
 *  query runs inside `withAccount`. */

const range = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})

/** Whatever arrives is clamped rather than refused: a range the wrong way round,
 *  or one that reaches back to 1970, is a mistake in a link and the useful answer
 *  is the range they meant. */
const within = (input: z.infer<typeof range>) => clampRange(input)

export const reportingRouter = router({
  pipeline: protectedProcedure
    .input(range)
    .query(({ ctx, input }) => call(() => pipelineReport(ctx.account, within(input)))),

  forms: protectedProcedure
    .input(range)
    .query(({ ctx, input }) => call(() => formsReport(ctx.account, within(input)))),

  sequences: protectedProcedure
    .input(range)
    .query(({ ctx, input }) => call(() => sequencesReport(ctx.account, within(input)))),

  email: protectedProcedure
    .input(range)
    .query(({ ctx, input }) => call(() => emailReport(ctx.account, within(input)))),

  website: protectedProcedure
    .input(range)
    .query(({ ctx, input }) => call(() => websiteReport(ctx.account, within(input)))),

  attribution: protectedProcedure
    .input(range)
    .query(({ ctx, input }) => call(() => attributionReport(ctx.account, within(input)))),

  /** B11. A dashboard is a saved arrangement of the figures above. Reading one is
   *  open to anybody signed in for the same reason the reports are; writing one is
   *  open to a viewer too, because a viewer arranging their own four numbers adds
   *  nothing they could not already read. */
  dashboards: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listReportDashboards(ctx.account))),

    read: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .query(({ ctx, input }) => call(() => readReportDashboard(ctx.account, input.id))),

    save: protectedProcedure
      .input(
        z.object({
          id: z.uuid().nullish(),
          name: z.string().min(1).max(120),
          cards: z.array(z.string().max(64)).min(1).max(24),
          isShared: z.boolean(),
        }),
      )
      .mutation(({ ctx, input }) => call(() => saveReportDashboard(ctx.account, input))),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => deleteReportDashboard(ctx.account, input.id))),
  }),
})
