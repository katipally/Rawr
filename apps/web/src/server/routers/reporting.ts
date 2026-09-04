import {
  attributionReport,
  clampRange,
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
 *  about the workspace's own work, and the records behind them are already visible
 *  to a viewer one at a time. Nothing here reaches across tenants, because every
 *  query runs inside `withWorkspace`. */

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
    .query(({ ctx, input }) => call(() => pipelineReport(ctx.workspace, within(input)))),

  forms: protectedProcedure
    .input(range)
    .query(({ ctx, input }) => call(() => formsReport(ctx.workspace, within(input)))),

  sequences: protectedProcedure
    .input(range)
    .query(({ ctx, input }) => call(() => sequencesReport(ctx.workspace, within(input)))),

  email: protectedProcedure
    .input(range)
    .query(({ ctx, input }) => call(() => emailReport(ctx.workspace, within(input)))),

  website: protectedProcedure
    .input(range)
    .query(({ ctx, input }) => call(() => websiteReport(ctx.workspace, within(input)))),

  attribution: protectedProcedure
    .input(range)
    .query(({ ctx, input }) => call(() => attributionReport(ctx.workspace, within(input)))),
})
