import {
  confirmSpam,
  FORM_FIELD_TYPES,
  getForm,
  listForms,
  listSubmissions,
  releaseSubmission,
  saveForm,
  type FormField,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { protectedProcedure, router } from '../trpc.ts'

/** Mirrors FormField exactly. The data access layer validates the schema again on
 *  save, so this is the shape gate and that is the rule gate; neither is the
 *  only one. */
const fieldSchema = z.object({
  key: z.string(),
  type: z.enum(FORM_FIELD_TYPES),
  label: z.string(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  validation: z
    .object({
      regex: z.string().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      minLength: z.number().optional(),
      maxLength: z.number().optional(),
    })
    .optional(),
  visibleIf: z.object({ field: z.string(), equals: z.string() }).optional(),
  mapsTo: z.string().nullable().optional(),
  step: z.number().int().min(0).optional(),
  defaultValue: z.string().optional(),
})

const settingsSchema = z.object({
  submitLabel: z.string(),
  successMode: z.enum(['message', 'redirect']),
  successValue: z.string(),
  notifySlack: z.boolean(),
  slackChannel: z.string().nullable().optional(),
  lifecycleStageOnSubmit: z.string().nullable().optional(),
  subscriptionOptIns: z.array(z.string()).optional(),
  steps: z.array(z.string()).optional(),
})

export const formsRouter = router({
  list: protectedProcedure.query(({ ctx }) => call(() => listForms(ctx.workspace))),

  get: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => call(() => getForm(ctx.workspace, input.id))),

  save: protectedProcedure
    .input(
      z.object({
        id: z.uuid().nullable().optional(),
        name: z.string(),
        slug: z.string(),
        isActive: z.boolean(),
        fields: z.array(fieldSchema),
        settings: settingsSchema,
      }),
    )
    .mutation(({ ctx, input }) =>
      call(() =>
        saveForm(ctx.workspace, {
          id: input.id ?? null,
          name: input.name,
          slug: input.slug,
          isActive: input.isActive,
          fields: input.fields as FormField[],
          settings: input.settings,
        }),
      ),
    ),

  submissions: protectedProcedure
    .input(
      z.object({
        state: z.enum(['clean', 'quarantined', 'confirmed_spam', 'released']).optional(),
        formId: z.uuid().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ ctx, input }) => call(() => listSubmissions(ctx.workspace, input))),

  /** Runs the full capture path from step 5 with the original timestamp, so a
   *  week-old lead does not appear on the timeline as having arrived today. */
  release: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => releaseSubmission(ctx.workspace, input.id))),

  confirmSpam: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => confirmSpam(ctx.workspace, input.id))),
})
