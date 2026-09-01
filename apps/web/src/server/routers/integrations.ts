import {
  acceptSuggestion,
  claimForReplay,
  dismissSuggestion,
  disconnectIntegration,
  listSuggestions,
  listUnmatchedEvents,
  readFieldSources,
  rematchInbound,
  releaseReplay,
  saveIntegration,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { enrichRecord, INTEGRATIONS, readIntegrations, testConnection } from '../integrations/index.ts'
import { pushSegmentToBrevo } from '../integrations/brevo.ts'
import { apolloContactUrl } from '../integrations/apollo.ts'
import { replayJob } from '../integrations/replay.ts'
import { adminProcedure, protectedProcedure, router } from '../trpc.ts'

/** F6. Everything about a connected service: what it is, whether it is working,
 *  and what it did or refused to do. */

const kind = z.enum(['brevo', 'apollo', 'clay', 'slack', 'ga4', 'zoom', 'google_calendar'])

export const integrationsRouter = router({
  /** Readable by anybody signed in, because a degraded integration explains why a
   *  record looks stale and that is not admin-only information. Credentials are
   *  never in this payload. */
  list: protectedProcedure.query(({ ctx }) => call(() => readIntegrations(ctx.workspace))),

  catalogue: protectedProcedure.query(() => INTEGRATIONS),

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
  pushSegment: protectedProcedure
    .input(z.object({ segmentId: z.uuid(), listId: z.number().int().min(1) }))
    .mutation(({ ctx, input }) =>
      call(() => pushSegmentToBrevo(ctx.workspace, { segmentId: input.segmentId, listId: input.listId })),
    ),

  enrich: protectedProcedure
    .input(z.object({ contactId: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => enrichRecord(ctx.workspace, input.contactId))),

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
