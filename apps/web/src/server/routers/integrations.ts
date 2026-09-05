import {
  acceptSuggestion,
  claimForReplay,
  createWebhookEndpoint,
  dismissSuggestion,
  disconnectIntegration,
  INTEGRATION_KINDS,
  listSuggestions,
  listUnmatchedEvents,
  listWebhookEndpoints,
  readFieldSources,
  rematchInbound,
  releaseReplay,
  removeWebhookEndpoint,
  rollWebhookSecret,
  saveIntegration,
  updateWebhookEndpoint,
  webhookEventsFor,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { enrichCompanyRecord, enrichRecord, INTEGRATIONS, readIntegrations, testConnection } from '../integrations/index.ts'
import {
  listBrevoCampaigns,
  listBrevoTemplates,
  pushSegmentToBrevo,
  scheduleBrevoCampaign,
  sendBrevoCampaign,
} from '../integrations/brevo.ts'
import {
  apolloContactUrl,
  syncSequenceActivity,
} from '../integrations/apollo.ts'
import { replayJob } from '../integrations/replay.ts'
import { listWoodpeckerCampaigns } from '../integrations/woodpecker.ts'
import { adminProcedure, protectedProcedure, router } from '../trpc.ts'

/** F6. Everything about a connected service: what it is, whether it is working,
 *  and what it did or refused to do. */

// Mirrors INTEGRATION_KINDS. A kind the registry knows and this does not is a
// settings page that cannot save it.
const kind = z.enum(INTEGRATION_KINDS)

/** More than any endpoint subscribes to. The catalogue grows by one per object an
 *  admin invents, so the cap cannot be the fixed list's own length. */
const MAX_SUBSCRIBED_EVENTS = 100

export const integrationsRouter = router({
  /** Readable by anybody signed in, because a degraded integration explains why a
   *  record looks stale and that is not admin-only information. Credentials are
   *  never in this payload. */
  list: protectedProcedure.query(({ ctx }) => call(() => readIntegrations(ctx.workspace))),

  catalogue: protectedProcedure.query(() => INTEGRATIONS),

  /** The campaigns a Woodpecker sequence can point at. Read rather than admin: the
   *  person writing the sequence needs the list, and a campaign name is not a
   *  credential. */
  woodpeckerCampaigns: protectedProcedure.query(({ ctx }) =>
    call(() => listWoodpeckerCampaigns(ctx.workspace)),
  ),

  save: adminProcedure
    .input(
      z.object({
        kind,
        config: z.record(z.string().max(64), z.unknown()).optional(),
        /** Undefined leaves the stored one alone; an empty string clears it. */
        secret: z.string().max(4000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      call(() =>
        saveIntegration(ctx.workspace, {
          kind: input.kind,
          ...(input.config !== undefined ? { config: input.config } : {}),
          ...(input.secret !== undefined ? { secret: input.secret } : {}),
        }),
      ),
    ),

  /** F6 §1: the user runs this on save, it calls the provider, and it reports the
   *  provider's real answer. */
  test: adminProcedure
    .input(z.object({ kind }))
    .mutation(({ ctx, input }) => call(() => testConnection(ctx.workspace, input.kind))),

  disconnect: adminProcedure
    .input(z.object({ kind }))
    .mutation(({ ctx, input }) => call(() => disconnectIntegration(ctx.workspace, input.kind))),

  /** A Rawr segment becomes a Brevo list. Nobody who has opted out is included,
   *  and running it twice pushes each contact once. F6 §2. */
  /** B12. Brevo keeps the designer and the sending reputation; Rawr owns the
   *  audience, the opt-out, the schedule and the numbers. */
  brevoTemplates: protectedProcedure.query(({ ctx }) => call(() => listBrevoTemplates(ctx.workspace))),

  brevoCampaigns: protectedProcedure.query(({ ctx }) => call(() => listBrevoCampaigns(ctx.workspace))),

  scheduleCampaign: protectedProcedure
    .input(
      z.object({
        segmentId: z.uuid(),
        listId: z.number().int().positive(),
        name: z.string().min(1).max(120),
        subject: z.string().min(1).max(200),
        senderName: z.string().min(1).max(120),
        senderEmail: z.email(),
        templateId: z.number().int().positive(),
        scheduledAt: z.string().datetime().nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      call(() =>
        scheduleBrevoCampaign(ctx.workspace, {
          segmentId: input.segmentId,
          listId: input.listId,
          name: input.name,
          subject: input.subject,
          senderName: input.senderName,
          senderEmail: input.senderEmail,
          templateId: input.templateId,
          ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
        }),
      ),
    ),

  sendCampaign: protectedProcedure
    .input(z.object({ campaignId: z.number().int().positive() }))
    .mutation(({ ctx, input }) => call(() => sendBrevoCampaign(ctx.workspace, input.campaignId))),

  pushSegment: protectedProcedure
    .input(z.object({ segmentId: z.uuid(), listId: z.number().int().min(1) }))
    .mutation(({ ctx, input }) =>
      call(() => pushSegmentToBrevo(ctx.workspace, { segmentId: input.segmentId, listId: input.listId })),
    ),

  enrich: protectedProcedure
    .input(z.object({ contactId: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => enrichRecord(ctx.workspace, input.contactId))),

  /** A company by its domain, so one with no contact yet is still enrichable. */
  enrichCompany: protectedProcedure
    .input(z.object({ companyId: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => enrichCompanyRecord(ctx.workspace, input.companyId))),

  /** What Apollo's own sequences did for this contact, read back onto the
   *  timeline. Enrolling happens in Rawr now: mail sent from Apollo does not
   *  thread with the rest of the conversation and does not stop when somebody
   *  replies here, which is the whole reason sequences moved in-house. */
  apolloStatus: protectedProcedure
    .input(z.object({ contactId: z.uuid() }))
    .query(({ ctx, input }) => call(() => syncSequenceActivity(ctx.workspace, input.contactId))),

  /** F6 §4. What enrichment was not allowed to write, so a person can decide. */
  suggestions: protectedProcedure
    .input(z.object({ entity: z.string().max(32).optional(), entityId: z.uuid().optional() }).optional())
    .query(({ ctx, input }) => call(() => listSuggestions(ctx.workspace, input?.entity, input?.entityId))),

  acceptSuggestion: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => acceptSuggestion(ctx.workspace, input.id))),

  dismissSuggestion: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => dismissSuggestion(ctx.workspace, input.id))),

  /** Where a value came from, so a record can show that a human typed something
   *  and enrichment is leaving it alone. */
  provenance: protectedProcedure
    .input(z.object({ entity: z.string().max(32), entityId: z.uuid() }))
    .query(({ ctx, input }) =>
      call(async () => {
        const map = await readFieldSources(ctx.workspace, input.entity, input.entityId)
        return Object.fromEntries(map)
      }),
    ),

  /** F6 §3. Tracking events for addresses nobody knows, kept rather than dropped. */
  unmatched: protectedProcedure.query(({ ctx }) => call(() => listUnmatchedEvents(ctx.workspace))),

  rematch: protectedProcedure.mutation(({ ctx }) => call(() => rematchInbound(ctx.workspace))),

  apolloLink: protectedProcedure
    .input(z.object({ email: z.email() }))
    .query(({ input }) => apolloContactUrl(input.email)),

  /** F6 §1's replay, for every job family rather than one. The idempotency key on
   *  the outbound call is what makes replaying twice a no-op. */
  /** B12. Who is subscribed to what happens here.
   *
   *  On the integrations router rather than a new one: an endpoint is a connected
   *  service like any other, with the same health line and the same replay behind
   *  it, and the screen it lives on is the one that already shows those. */
  webhooks: router({
    list: adminProcedure.query(({ ctx }) => call(() => listWebhookEndpoints(ctx.workspace))),

    events: adminProcedure.query(({ ctx }) => call(() => webhookEventsFor(ctx.workspace))),

    create: adminProcedure
      .input(
        z.object({
          name: z.string().min(1).max(80),
          url: z.string().min(1).max(2000),
          events: z.array(z.string().max(64)).max(MAX_SUBSCRIBED_EVENTS),
        }),
      )
      // The secret comes back exactly once, here, the way an agent token does.
      .mutation(({ ctx, input }) => call(() => createWebhookEndpoint(ctx.workspace, input))),

    update: adminProcedure
      .input(
        z.object({
          id: z.uuid(),
          name: z.string().min(1).max(80).optional(),
          url: z.string().min(1).max(2000).optional(),
          events: z.array(z.string().max(64)).max(MAX_SUBSCRIBED_EVENTS).optional(),
          isActive: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input: { id, ...rest } }) =>
        call(() => updateWebhookEndpoint(ctx.workspace, id, rest)),
      ),

    rollSecret: adminProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => rollWebhookSecret(ctx.workspace, input.id))),

    remove: adminProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => removeWebhookEndpoint(ctx.workspace, input.id))),
  }),

  replay: adminProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      call(async () => {
        const claimed = await claimForReplay(ctx.workspace, input.id)
        try {
          return await replayJob(ctx.workspace, claimed)
        } catch (cause) {
          // The claim is undone so a replay that never ran does not read as one
          // that already did.
          await releaseReplay(ctx.workspace, input.id)
          throw cause
        }
      }),
    ),
})
