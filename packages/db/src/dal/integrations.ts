import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  deadLetter,
  enrichmentSuggestion,
  fieldSource,
  inboundEvent,
  integration,
  outboundCall,
} from '../schema/platform.ts'
import { decryptToken, encryptToken, randomToken } from '../internal/crypto.ts'
import { assertCanWrite, type WorkspaceContext } from './context.ts'
import { mutate, withWorkspace, type Tx } from './index.ts'

/** F6 §1, built once and used by every integration without exception.
 *
 *  Credentials live encrypted with a key held outside this database, never in
 *  `config`, which is why `config` is safe to render in the UI and the secret is
 *  not. Everything else here exists because an integration that fails silently is
 *  worse than one that is absent: a health state with the provider's real error, an
 *  idempotency key per outbound call, deduplication per inbound event, and a
 *  dead-letter row for anything that ran out of retries. */

export type IntegrationKind =
  | 'brevo'
  | 'apollo'
  | 'clay'
  | 'slack'
  | 'ga4'
  | 'zoom'
  | 'google_calendar'

export const INTEGRATION_KINDS: IntegrationKind[] = [
  'brevo',
  'apollo',
  'clay',
  'slack',
  'ga4',
  'zoom',
  'google_calendar',
]

/** F6 §1's four states. The stored column predates the doc's wording, so the two
 *  names that differ are mapped here rather than migrated: 'revoked' is stored,
 *  'disconnected' is what a person reads. */
export type HealthState = 'connected' | 'degraded' | 'disconnected' | 'not_configured'

type StoredState = 'connected' | 'degraded' | 'revoked' | 'unconfigured'

export type IntegrationRow = {
  id: string | null
  kind: IntegrationKind
  config: Record<string, unknown>
  hasSecret: boolean
  state: HealthState
  lastOkAt: Date | null
  lastError: string | null
  lastErrorAt: Date | null
  deadLetters: number
}

/** How long since the last success before a connected integration reads as
 *  degraded. Long enough that a nightly sync is not permanently amber, short
 *  enough that a silently dead webhook is visible the next day. */
const STALE_MS = 36 * 60 * 60 * 1000

const healthOf = (row: {
  state: string
  lastOkAt: Date | null
  lastError: string | null
}): HealthState => {
  if (row.state === 'unconfigured') return 'not_configured'
  if (row.state === 'revoked') return 'disconnected'
  if (row.lastError) return 'degraded'
  if (!row.lastOkAt) return 'degraded'
  return Date.now() - row.lastOkAt.getTime() > STALE_MS ? 'degraded' : 'connected'
}

export const listIntegrations = async (ctx: WorkspaceContext): Promise<IntegrationRow[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx.select().from(integration)
    const failures = await tx.execute<{ integration_id: string | null; n: number }>(
      sql`select integration_id, count(*)::int as n from dead_letter
           where replayed_at is null group by integration_id`,
    )
    const byIntegration = new Map(failures.map((row) => [row.integration_id, Number(row.n)]))

    // Every known kind appears, configured or not. An integration that is simply
    // absent is a state somebody needs to see, not a missing row.
    return INTEGRATION_KINDS.map((kind) => {
      const found = rows.find((row) => row.kind === kind)
      if (!found) {
        return {
          id: null,
          kind,
          config: {},
          hasSecret: false,
          state: 'not_configured' as const,
          lastOkAt: null,
          lastError: null,
          lastErrorAt: null,
          deadLetters: 0,
        }
      }
      return {
        id: found.id,
        kind,
        config: (found.config ?? {}) as Record<string, unknown>,
        hasSecret: found.secretRef !== null,
        state: healthOf(found),
        lastOkAt: found.lastOkAt,
        lastError: found.lastError,
        lastErrorAt: found.lastErrorAt,
        deadLetters: byIntegration.get(found.id) ?? 0,
      }
    })
  })

export type SaveIntegrationInput = {
  kind: IntegrationKind
  config?: Record<string, unknown>
  /** Plain text, encrypted before it reaches a column. Undefined leaves the stored
   *  one alone, so saving a config change does not require re-typing the key. */
  secret?: string | null
}

export const saveIntegration = async (
  ctx: WorkspaceContext,
  input: SaveIntegrationInput,
): Promise<{ id: string }> =>
  mutate(ctx, 'integration', async (tx) => {
    const secretRef = input.secret === undefined ? undefined : input.secret ? encryptToken(input.secret) : null
    // Brevo does not sign its webhooks, so the URL Rawr hands it carries a token
    // minted here once and kept across saves. Compared on every delivery.
    const config =
      input.config !== undefined && input.kind === 'brevo' && typeof input.config.webhookToken !== 'string'
        ? { ...input.config, webhookToken: randomToken(24) }
        : input.config

    const [saved] = await tx
      .insert(integration)
      .values({
        workspaceId: ctx.workspaceId,
        kind: input.kind,
        config: config ?? {},
        secretRef: secretRef ?? null,
        // Saved but never yet tested. The connection test is what moves it on.
        state: 'connected',
        lastError: null,
        lastErrorAt: null,
      })
      .onConflictDoUpdate({
        target: [integration.workspaceId, integration.kind],
        set: {
          ...(config !== undefined ? { config } : {}),
          ...(secretRef !== undefined ? { secretRef } : {}),
          state: 'connected',
          lastError: null,
          lastErrorAt: null,
        },
      })
      .returning({ id: integration.id })
    if (!saved) throw new Error('The integration could not be saved.')

    return {
      result: { id: saved.id },
      audit: {
        entity: 'integration',
        entityId: saved.id,
        action: 'save',
        before: null,
        // Never the secret itself, only that one was supplied.
        after: { kind: input.kind, config: config ?? {}, secretChanged: secretRef !== undefined },
      },
    }
  })

export type Credentials = { id: string; config: Record<string, unknown>; secret: string | null }

/** Decrypted only here, only for a call that is about to be made. */
export const readCredentials = async (
  ctx: WorkspaceContext,
  kind: IntegrationKind,
): Promise<Credentials | null> =>
  withWorkspace(ctx, async (tx) => {
    const [row] = await tx.select().from(integration).where(eq(integration.kind, kind)).limit(1)
    if (!row) return null
    return {
      id: row.id,
      config: (row.config ?? {}) as Record<string, unknown>,
      secret: row.secretRef ? decryptToken(row.secretRef) : null,
    }
  })

export const recordHealth = async (
  ctx: WorkspaceContext,
  kind: IntegrationKind,
  outcome: { ok: true } | { ok: false; error: string; disconnected?: boolean },
): Promise<void> => {
  await withWorkspace(ctx, async (tx) => {
    await tx
      .update(integration)
      .set(
        outcome.ok
          ? { lastOkAt: new Date(), lastError: null, lastErrorAt: null, state: 'connected' }
          : {
              lastError: outcome.error.slice(0, 2000),
              lastErrorAt: new Date(),
              // A rejected credential is not a blip. Retrying it would burn every
              // attempt against a decision made at the provider. F6's edge cases.
              state: (outcome.disconnected ? 'revoked' : 'degraded') satisfies StoredState,
            },
      )
      .where(eq(integration.kind, kind))
  })
}

export const disconnectIntegration = async (
  ctx: WorkspaceContext,
  kind: IntegrationKind,
): Promise<void> =>
  mutate(ctx, 'integration', async (tx) => {
    // The row's own id, not the kind: audit_log.entity_id is a uuid column, and
    // writing a name into it fails at the database rather than at the call.
    const [found] = await tx
      .select({ id: integration.id })
      .from(integration)
      .where(eq(integration.kind, kind))
      .limit(1)
    if (!found) throw new Error(`${kind} is not connected in this workspace.`)

    await tx.delete(integration).where(eq(integration.id, found.id))
    return {
      result: undefined,
      audit: { entity: 'integration', entityId: found.id, action: 'disconnect', before: { kind }, after: null },
    }
  })

// ---------------------------------------------------------- idempotency

export type CallOutcome<T> = { fresh: boolean; response: T }

/** Runs one outbound call at most once per key.
 *
 *  The key is derived from what is being sent, never random, so a retry of the same
 *  work produces the same key and the second attempt returns the first attempt's
 *  answer instead of sending again. This is what makes replaying a dead-lettered
 *  item safe to do twice. F6's edge-case table.
 *
 *  The claim is a separate transaction from the call itself: holding a transaction
 *  open across an HTTP request would pin a connection for as long as the provider
 *  takes to answer. */
export const once = async <T>(
  ctx: WorkspaceContext,
  input: { key: string; operation: string; integrationId?: string | null },
  run: () => Promise<T>,
): Promise<CallOutcome<T>> => {
  const existing = await withWorkspace(ctx, async (tx) => {
    const [row] = await tx
      .select({ response: outboundCall.response })
      .from(outboundCall)
      .where(eq(outboundCall.idempotencyKey, input.key))
      .limit(1)
    return row
  })
  if (existing) return { fresh: false, response: existing.response as T }

  const response = await run()

  await withWorkspace(ctx, async (tx) => {
    await tx
      .insert(outboundCall)
      .values({
        workspaceId: ctx.workspaceId,
        integrationId: input.integrationId ?? null,
        idempotencyKey: input.key,
        operation: input.operation,
        response: (response ?? null) as never,
      })
      .onConflictDoNothing()
  })

  return { fresh: true, response }
}

/** Inbound deduplication, the mirror of `once`. Returns false when this event has
 *  already been handled, so a provider that delivers twice is processed once. */
export const claimInbound = async (
  ctx: WorkspaceContext,
  input: {
    source: string
    providerEventId: string
    kind: string
    payload: unknown
    contactId?: string | null
  },
): Promise<boolean> =>
  withWorkspace(ctx, async (tx) => {
    const [claimed] = await tx
      .insert(inboundEvent)
      .values({
        workspaceId: ctx.workspaceId,
        source: input.source,
        providerEventId: input.providerEventId,
        kind: input.kind,
        payload: input.payload as never,
        contactId: input.contactId ?? null,
        matched: Boolean(input.contactId),
      })
      .onConflictDoNothing()
      .returning({ id: inboundEvent.id })
    return Boolean(claimed)
  })

export type UnmatchedEvent = {
  id: string
  source: string
  kind: string
  payload: unknown
  at: Date
}

/** F6 §3. An event for an address nobody knows is stored against no contact and
 *  surfaced here rather than dropped, because "nobody opened it" and "we could not
 *  tell who opened it" are different answers. */
export const listUnmatchedEvents = async (
  ctx: WorkspaceContext,
  limit = 50,
): Promise<UnmatchedEvent[]> =>
  withWorkspace(ctx, (tx) =>
    tx
      .select({
        id: inboundEvent.id,
        source: inboundEvent.source,
        kind: inboundEvent.kind,
        payload: inboundEvent.payload,
        at: inboundEvent.at,
      })
      .from(inboundEvent)
      .where(eq(inboundEvent.matched, false))
      .orderBy(desc(inboundEvent.at))
      .limit(Math.min(Math.max(limit, 1), 200)),
  )

/** Re-runs the match for events that arrived before the contact existed. Somebody
 *  who fills in a form after an email was tracked should still get that open on
 *  their timeline. */
export const rematchInbound = async (ctx: WorkspaceContext): Promise<{ matched: number }> => {
  assertCanWrite(ctx, 'integration')
  return withWorkspace(ctx, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      update inbound_event e
         set contact_id = c.id, matched = true
        from contact c
       where e.matched = false
         and c.deleted_at is null
         and lower(c.email) = lower(e.payload ->> 'email')
      returning e.id`)
    return { matched: rows.length }
  })
}

// ------------------------------------------------------------ provenance

export type FieldSourceKind = 'human' | 'import' | 'enrichment' | 'form' | 'booking' | 'product'

export const recordFieldSource = async (
  tx: Tx,
  ctx: WorkspaceContext,
  input: { entity: string; entityId: string; fieldKey: string; source: FieldSourceKind; provider?: string | null },
): Promise<void> => {
  await tx
    .insert(fieldSource)
    .values({
      workspaceId: ctx.workspaceId,
      entity: input.entity,
      entityId: input.entityId,
      fieldKey: input.fieldKey,
      source: input.source,
      provider: input.provider ?? null,
    })
    .onConflictDoUpdate({
      target: [fieldSource.workspaceId, fieldSource.entity, fieldSource.entityId, fieldSource.fieldKey],
      set: { source: input.source, provider: input.provider ?? null, at: new Date() },
    })
}

export const readFieldSources = async (
  ctx: WorkspaceContext,
  entity: string,
  entityId: string,
): Promise<Map<string, { source: FieldSourceKind; provider: string | null }>> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx
      .select({ fieldKey: fieldSource.fieldKey, source: fieldSource.source, provider: fieldSource.provider })
      .from(fieldSource)
      .where(and(eq(fieldSource.entity, entity), eq(fieldSource.entityId, entityId)))
    return new Map(rows.map((row) => [row.fieldKey, { source: row.source, provider: row.provider }]))
  })

export type SuggestionRow = {
  id: string
  entity: string
  entityId: string
  fieldKey: string
  suggested: string
  current: string | null
  provider: string
  at: Date
}

export const listSuggestions = async (
  ctx: WorkspaceContext,
  entity?: string,
  entityId?: string,
): Promise<SuggestionRow[]> =>
  withWorkspace(ctx, (tx) =>
    tx
      .select()
      .from(enrichmentSuggestion)
      .where(
        entity && entityId
          ? and(eq(enrichmentSuggestion.entity, entity), eq(enrichmentSuggestion.entityId, entityId))
          : undefined,
      )
      .orderBy(desc(enrichmentSuggestion.at))
      .limit(200),
  )

export const dismissSuggestion = async (ctx: WorkspaceContext, id: string): Promise<void> => {
  // Dismissing is a decision about the record, so it takes the record's write role.
  assertCanWrite(ctx, 'contact')
  await withWorkspace(ctx, async (tx) => {
    await tx.delete(enrichmentSuggestion).where(eq(enrichmentSuggestion.id, id))
  })
}

// ------------------------------------------------------------- failures

/** Generic replay. The dead letter carries the job name and its payload, so a
 *  replay is "put this back on the queue"; the idempotency key on the outbound call
 *  is what makes doing that twice a no-op. F6's edge-case table.
 *
 *  Job families that cannot be replayed by re-enqueueing say so by name rather than
 *  pretending, because a button that quietly does nothing is worse than one that
 *  explains itself. */
export type Replayable = { jobName: string; payload: unknown; workspaceId: string }

export const claimForReplay = async (ctx: WorkspaceContext, id: string): Promise<Replayable> =>
  mutate(ctx, 'dead_letter', async (tx) => {
    const [row] = await tx
      .select({ jobName: deadLetter.jobName, payload: deadLetter.payload })
      .from(deadLetter)
      .where(and(eq(deadLetter.id, id), isNull(deadLetter.replayedAt)))
      .limit(1)
    if (!row) throw new Error('That failure has already been replayed, or it does not exist.')

    await tx.update(deadLetter).set({ replayedAt: new Date() }).where(eq(deadLetter.id, id))

    return {
      result: { jobName: row.jobName, payload: row.payload, workspaceId: ctx.workspaceId },
      audit: {
        entity: 'dead_letter',
        entityId: id,
        action: 'replay',
        before: { replayedAt: null },
        after: { replayedAt: 'now', jobName: row.jobName },
      },
    }
  })

/** Undoes the claim when the enqueue itself failed, so a replay that never reached
 *  the queue does not read as one that was already done. */
export const releaseReplay = async (ctx: WorkspaceContext, id: string): Promise<void> => {
  await withWorkspace(ctx, async (tx) => {
    await tx.update(deadLetter).set({ replayedAt: null }).where(eq(deadLetter.id, id))
  })
}
