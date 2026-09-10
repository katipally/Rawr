import {
  cloneForm,
  confirmSpam,
  deleteFormFolder,
  FORM_FIELD_TYPES,
  getForm,
  listFormFolders,
  listForms,
  listSubmissions,
  moveFormToFolder,
  releaseSubmission,
  saveForm,
  saveFormFolder,
  type FormField,
  deleteForm,
  readSettings,
  uploadsForSubmission,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { NOT_CONFIGURED, signedDownload, storageConfigured } from '../storage.ts'
import { protectedProcedure, router } from '../trpc.ts'

/** Mirrors FormField exactly. The data access layer validates the schema again on
 *  save, so this is the shape gate and that is the rule gate; neither is the
 *  only one. */
const fieldSchema = z.object({
  key: z.string(),
  type: z.enum(FORM_FIELD_TYPES),
  label: z.string(),
  // A stored field reads back with nulls where nothing was set. Accepted as
  // "not set" rather than refused, or an existing form could never be re-saved.
  placeholder: z.string().nullish(),
  help: z.string().nullish(),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).nullish(),
  validation: z
    .object({
      regex: z.string().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      minLength: z.number().optional(),
      maxLength: z.number().optional(),
    })
    .nullish(),
  visibleIf: z.object({ field: z.string(), equals: z.string() }).nullish(),
  mapsTo: z.string().nullable().optional(),
  step: z.number().int().min(0).optional(),
  defaultValue: z.string().nullish(),
})

const settingsSchema = z.object({
  submitLabel: z.string(),
  successMode: z.enum(['message', 'redirect']),
  successValue: z.string(),
  notifySlack: z.boolean(),
  slackChannel: z.string().nullable().optional(),
  lifecycleStageOnSubmit: z.string().nullable().optional(),
  subscriptionOptIns: z.array(z.string()).optional(),
  steps: z.array(z.string()).nullish(),
  // Shape only. readTheme is the gate on the values, and it runs on the way in
  // and on the way out, so a token that could close a CSS declaration never
  // reaches a stylesheet however it was stored.
  theme: z.object({ preset: z.string(), tokens: z.record(z.string(), z.string()) }).optional(),
  assignOwner: z
    .object({ mode: z.enum(['none', 'user', 'round_robin']), userId: z.uuid().nullable().optional(), pool: z.array(z.uuid()).optional() })
    .optional(),
})

export const formsRouter = router({
  list: protectedProcedure.query(({ ctx }) => call(() => listForms(ctx.account))),

  get: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => call(() => getForm(ctx.account, input.id))),

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
        saveForm(ctx.account, {
          id: input.id ?? null,
          name: input.name,
          slug: input.slug,
          isActive: input.isActive,
          fields: input.fields as FormField[],
          // Normalised the way a stored form reads back, nulls and all.
          settings: readSettings(input.settings),
        }),
      ),
    ),

  remove: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => deleteForm(ctx.account, input.id))),

  clone: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => cloneForm(ctx.account, input.id))),

  folders: protectedProcedure.query(({ ctx }) => call(() => listFormFolders(ctx.account))),

  saveFolder: protectedProcedure
    .input(z.object({ id: z.uuid().nullable().optional(), name: z.string().max(120) }))
    .mutation(({ ctx, input }) =>
      call(() => saveFormFolder(ctx.account, { id: input.id ?? null, name: input.name })),
    ),

  removeFolder: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => deleteFormFolder(ctx.account, input.id))),

  moveToFolder: protectedProcedure
    .input(z.object({ formId: z.uuid(), folderId: z.uuid().nullable() }))
    .mutation(({ ctx, input }) => call(() => moveFormToFolder(ctx.account, input))),

  submissions: protectedProcedure
    .input(
      z.object({
        state: z.enum(['clean', 'quarantined', 'confirmed_spam', 'released']).optional(),
        formId: z.uuid().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ ctx, input }) => call(() => listSubmissions(ctx.account, input))),

  /** Runs the full capture path from step 5 with the original timestamp, so a
   *  week-old lead does not appear on the timeline as having arrived today. */
  release: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => releaseSubmission(ctx.account, input.id))),

  confirmSpam: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => confirmSpam(ctx.account, input.id))),

  /** A link to one file a stranger attached, minted per click and short lived.
   *  The row is read under the account first, which is what proves the key
   *  belongs here before a URL to it exists. */
  uploadLink: protectedProcedure
    .input(z.object({ submissionId: z.uuid(), uploadId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      call(async () => {
        if (!storageConfigured) throw new Error(NOT_CONFIGURED)
        const files = await uploadsForSubmission(ctx.account, input.submissionId)
        const file = files.find((row) => row.id === input.uploadId)
        if (!file) throw new Error('That file is gone.')
        return { url: await signedDownload(file.storageKey, 120, file.filename) }
      }),
    ),
})
