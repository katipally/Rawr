import {
  deleteSegment,
  evaluateAllSegments,
  evaluateSegment,
  listSegments,
  previewSegment,
  readMemberships,
  readSegmentMembers,
  saveSegment,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { protectedProcedure, router } from '../trpc.ts'

/** Segments. D15 put these in F1: a saved query with remembered membership, and
 *  entry and exit on the timeline. */

const objectKey = z.enum(['contact', 'company', 'deal'])
const condition = z.object({
  field: z.string().min(1).max(64),
  operator: z.string().min(1).max(24),
  value: z.unknown().optional(),
})
const filterGroup = z.object({
  conjunction: z.enum(['and', 'or']),
  conditions: z.array(condition).max(20),
})

export const segmentsRouter = router({
  list: protectedProcedure
    .input(z.object({ object: objectKey.optional() }).optional())
    .query(({ ctx, input }) => call(() => listSegments(ctx.workspace, input?.object))),

  save: protectedProcedure
    .input(
      z.object({
        id: z.uuid().nullish(),
        object: objectKey,
        name: z.string().trim().min(1).max(120),
        description: z.string().max(500).nullish(),
        filters: z.array(filterGroup).min(1).max(5),
      }),
    )
    .mutation(({ ctx, input }) =>
      call(() =>
        saveSegment(ctx.workspace, {
          id: input.id ?? null,
          objectKey: input.object,
          name: input.name,
          description: input.description ?? null,
          filters: input.filters as never,
        }),
      ),
    ),

  remove: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => deleteSegment(ctx.workspace, input.id))),

  /** Recompute one now. The scheduled pass covers the rest; this is for somebody
   *  who has just changed the query and wants to see the effect. */
  evaluate: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => evaluateSegment(ctx.workspace, input.id))),

  evaluateAll: protectedProcedure.mutation(({ ctx }) => call(() => evaluateAllSegments(ctx.workspace))),

  members: protectedProcedure
    .input(z.object({ id: z.uuid(), limit: z.number().int().min(1).max(200).optional() }))
    .query(({ ctx, input }) => call(() => readSegmentMembers(ctx.workspace, input.id, input.limit ?? 50))),

  /** What the builder shows before anything is saved: the count and a handful of
   *  the records, so nobody saves a segment they have not seen. */
  preview: protectedProcedure
    .input(z.object({ object: objectKey, filters: z.array(filterGroup).max(5) }))
    .query(({ ctx, input }) =>
      call(() => previewSegment(ctx.workspace, { objectKey: input.object, filters: input.filters as never })),
    ),

  /** The segments one record is in, past spells included. */
  forRecord: protectedProcedure
    .input(z.object({ entityId: z.uuid() }))
    .query(({ ctx, input }) => call(() => readMemberships(ctx.workspace, input.entityId))),
})
