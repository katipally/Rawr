import {
  enroll,
  enrollmentsForContact,
  listEnrollments,
  listSequences,
  pauseEnrollment,
  readSequence,
  readTrackingDomain,
  removeEnrollment,
  resumeEnrollment,
  saveSequence,
  saveSteps,
  setSequenceState,
  setTrackingDomain,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { adminProcedure, protectedProcedure, router } from '../trpc.ts'

/** Sequences: what they say, who is in them, and where the tracking lives.
 *
 *  Reads are open to anybody signed in, because outreach is not a secret from the
 *  team; every write goes through the role matrix, and the finer questions (whose
 *  enrollment is this to pause) are answered inside the data access layer. */

const window = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().min(1).max(64),
})

const settings = z
  .object({
    sendWindow: window,
    stopOnReply: z.boolean(),
    stopOnBounce: z.boolean(),
    stopOnUnsubscribe: z.boolean(),
    trackOpens: z.boolean(),
    trackClicks: z.boolean(),
    subscriptionTypeId: z.uuid().nullable(),
    replyInThread: z.boolean(),
    woodpeckerCampaignId: z.number().int().positive().nullable(),
  })
  .partial()

export const sequencesRouter = router({
  list: protectedProcedure.query(({ ctx }) => call(() => listSequences(ctx.workspace))),

  get: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => call(() => readSequence(ctx.workspace, input.id))),

  save: protectedProcedure
    .input(
      z.object({
        id: z.uuid().nullable().optional(),
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(500).nullable().optional(),
        sender: z.enum(['gmail', 'woodpecker']).optional(),
        settings: settings.optional(),
      }),
    )
    .mutation(({ ctx, input }) => call(() => saveSequence(ctx.workspace, input))),

  setState: protectedProcedure
    .input(z.object({ id: z.uuid(), state: z.enum(['draft', 'active', 'paused', 'archived']) }))
    .mutation(({ ctx, input }) => call(() => setSequenceState(ctx.workspace, input))),

  saveSteps: protectedProcedure
    .input(
      z.object({
        sequenceId: z.uuid(),
        steps: z
          .array(
            z.object({
              id: z.uuid().nullable().optional(),
              kind: z.enum(['email', 'call', 'linkedin', 'task']),
              delayDays: z.number().int().min(0).max(365),
              delayHours: z.number().int().min(0).max(23),
              subject: z.string().max(300).nullable().optional(),
              bodyHtml: z.string().max(100_000).nullable().optional(),
              bodyText: z.string().max(100_000).nullable().optional(),
              taskTitle: z.string().max(300).nullable().optional(),
              taskBody: z.string().max(5_000).nullable().optional(),
            }),
          )
          .max(50),
      }),
    )
    .mutation(({ ctx, input }) => call(() => saveSteps(ctx.workspace, input))),

  /** Returns one outcome per contact, so a partial success says which ones and
   *  why rather than reporting a number nobody can act on. */
  enroll: protectedProcedure
    .input(
      z.object({
        sequenceId: z.uuid(),
        contactIds: z.array(z.uuid()).min(1).max(500),
        mailboxId: z.uuid(),
      }),
    )
    .mutation(({ ctx, input }) => call(() => enroll(ctx.workspace, input))),

  enrollments: router({
    list: protectedProcedure
      .input(
        z.object({
          sequenceId: z.uuid(),
          state: z
            .enum(['active', 'waiting_task', 'paused', 'finished', 'replied', 'bounced', 'unsubscribed', 'failed', 'removed'])
            .nullable()
            .optional(),
          limit: z.number().int().min(1).max(500).optional(),
        }),
      )
      .query(({ ctx, input }) => call(() => listEnrollments(ctx.workspace, input))),

    forContact: protectedProcedure
      .input(z.object({ contactId: z.uuid() }))
      .query(({ ctx, input }) => call(() => enrollmentsForContact(ctx.workspace, input.contactId))),

    pause: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => pauseEnrollment(ctx.workspace, input.id))),

    resume: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => resumeEnrollment(ctx.workspace, input.id))),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => removeEnrollment(ctx.workspace, input.id))),
  }),

  tracking: router({
    get: protectedProcedure.query(({ ctx }) => call(() => readTrackingDomain(ctx.workspace))),
    set: adminProcedure
      .input(z.object({ domain: z.string().trim().max(200).nullable() }))
      .mutation(({ ctx, input }) => call(() => setTrackingDomain(ctx.workspace, input.domain))),
  }),
})
