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
import { assertCanWrite, type AccountContext } from './context.ts'
import { mutate, withAccount, type Tx } from './index.ts'
import { resolveNotifications } from './notifications.ts'

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
  | 'lusha'
  | 'woodpecker'
  | 'hubspot'
  | 'turnstile'
  | 'webflow'
  | 'gmail'

export const INTEGRATION_KINDS: IntegrationKind[] = [
  'brevo',
  'apollo',
  'clay',
  'slack',
  'ga4',
  'zoom',
  'google_calendar',
  'lusha',
  'woodpecker',
  'hubspot',
  'turnstile',
  'webflow',
  'gmail',
]

/** Granted per person rather than once for the company: there is no shared
 *  credential row, so their health is read from the grants themselves. */
export const PERSONAL_KINDS = new Set<IntegrationKind>(['gmail', 'google_calendar'])

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

/** The only kind that works on configuration alone: a measurement id is not a
 *  secret and there is nothing else to store. Every other provider needs a
 *  credential before it can do anything. */
const KEYLESS_KINDS = new Set<IntegrationKind>(['ga4'])

/** The stand-in providers answer from fixtures and have no key to paste, so a
 *  connection made against them would store a row with no `secret_ref`, which
 *  `healthOf` reads as never configured: the card offers Connect, the row is
 *  absent from the connected list, and nothing can remove it. Storing this marker
 *  where the credential would go makes it an ordinary connected row. */
const DEV_SECRET = 'dev'

const devIntegrations = (): boolean =>
  process.env.RAWR_DEV_INTEGRATIONS === '1' && process.env.NODE_ENV !== 'production'

const healthOf = (row: {
  kind: IntegrationKind
  hasSecret: boolean
  state: string
  lastOkAt: Date | null
  lastError: string | null
}): HealthState => {
  // Nothing was ever connected, whatever a stale last_ok_at or a seeded row
  // claims. Reporting otherwise puts "Connected" next to a Connect button.
  if (!row.hasSecret && !KEYLESS_KINDS.has(row.kind)) return 'not_configured'
  if (row.state === 'unconfigured') return 'not_configured'
  if (row.state === 'revoked') return 'disconnected'
  if (row.lastError) return 'degraded'
  if (!row.lastOkAt) return 'degraded'
  return Date.now() - row.lastOkAt.getTime() > STALE_MS ? 'degraded' : 'connected'
}

export const listIntegrations = async (ctx: AccountContext): Promise<IntegrationRow[]> =>
  withAccount(ctx, async (tx) => {
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
        state: healthOf({ ...found, kind, hasSecret: found.secretRef !== null }),
        lastOkAt: found.lastOkAt,
        lastError: found.lastError,
        lastErrorAt: found.lastErrorAt,
        deadLetters: byIntegration.get(found.id) ?? 0,
      }
    })
  })

/** What the Connected Apps table needs and the account list does not: who
 *  connected it, when, and when it last did anything. Read in an account
 *  transaction because that is the scope the screen is in, and because the
 *  installer's name comes from a join the account policy would not admit. */
const asDate = (value: string | Date | null): Date | null =>
  value === null ? null : value instanceof Date ? value : new Date(value)

export type AccountIntegrationRow = IntegrationRow & {
  installedAt: Date | null
  installedByName: string | null
  installedByEmail: string | null
  lastActivityAt: Date | null
  /** How many people hold a working grant. Only a personal app counts anyone. */
  people: number
}

/** One row per personal app, folded from every person's grant: connected while
 *  anyone's works, degraded when the newest failure is newer than the newest
 *  success, and absent until somebody connects. */
const personalRows = async (tx: Tx): Promise<Map<IntegrationKind, AccountIntegrationRow>> => {
  const rows = await tx.execute<{
    kind: IntegrationKind
    people: number
    installed_at: string | Date | null
    last_ok_at: string | Date | null
    last_error: string | null
    last_error_at: string | Date | null
  }>(sql`
    select 'gmail' as kind,
           count(*) filter (where m.state <> 'revoked')::int as people,
           min(m.created_at) as installed_at,
           max(m.last_sync_at) as last_ok_at,
           (array_agg(m.last_error order by m.last_error_at desc nulls last))[1] as last_error,
           max(m.last_error_at) as last_error_at
      from mailbox m
    union all
    select 'google_calendar',
           count(*) filter (where g.state = 'connected')::int,
           min(g.created_at), max(g.last_ok_at),
           (array_agg(g.last_error order by g.last_error_at desc nulls last))[1],
           max(g.last_error_at)
      from calendar_grant g`)

  return new Map(
    rows
      .filter((row) => row.installed_at !== null)
      .map((row) => {
        const lastOkAt = asDate(row.last_ok_at)
        const lastErrorAt = asDate(row.last_error_at)
        const failing = lastErrorAt !== null && (lastOkAt === null || lastErrorAt > lastOkAt)
        return [
          row.kind,
          {
            id: null,
            kind: row.kind,
            config: {},
            hasSecret: false,
            state: row.people === 0 ? ('disconnected' as const) : failing ? ('degraded' as const) : ('connected' as const),
            lastOkAt,
            lastError: failing ? row.last_error : null,
            lastErrorAt: failing ? lastErrorAt : null,
            deadLetters: 0,
            installedAt: asDate(row.installed_at),
            installedByName: null,
            installedByEmail: null,
            lastActivityAt: lastOkAt && lastErrorAt ? (lastOkAt > lastErrorAt ? lastOkAt : lastErrorAt) : (lastOkAt ?? lastErrorAt),
            people: Number(row.people),
          },
        ]
      }),
  )
}

export const listIntegrationsForAccount = async (
  ctx: AccountContext,
): Promise<AccountIntegrationRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      kind: string
      config: Record<string, unknown> | null
      secret_ref: string | null
      state: StoredState
      last_ok_at: string | Date | null
      last_error: string | null
      last_error_at: string | Date | null
      created_at: string | Date
      installed_by_name: string | null
      installed_by_email: string | null
      dead_letters: number
    }>(sql`
      select i.id, i.kind, i.config, i.secret_ref, i.state,
             i.last_ok_at, i.last_error, i.last_error_at, i.created_at,
             u.name as installed_by_name, u.email as installed_by_email,
             (select count(*)::int from dead_letter d
               where d.integration_id = i.id and d.replayed_at is null) as dead_letters
        from integration i
        left join user_account u on u.id = i.installed_by
       where i.account_id = ${ctx.accountId}`)

    const byKind = new Map(rows.map((row) => [row.kind, row]))
    const personal = await personalRows(tx)
    // Every known kind, connected or not: the Available list is the complement of
    // this one, and neither can be built from a table that only holds what exists.
    return INTEGRATION_KINDS.map((kind) => {
      const grant = personal.get(kind)
      if (grant) return grant
      const found = byKind.get(kind)
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
          installedAt: null,
          installedByName: null,
          installedByEmail: null,
          lastActivityAt: null,
          people: 0,
        }
      }
      // tx.execute hands back what the driver parsed, and a timestamptz arrives
      // as a string rather than the Date the typed select would have built.
      // healthOf calls getTime() on it, so the coercion is not cosmetic.
      const lastOkAt = asDate(found.last_ok_at)
      const lastErrorAt = asDate(found.last_error_at)
      return {
        id: found.id,
        kind,
        config: found.config ?? {},
        hasSecret: found.secret_ref !== null,
        state: healthOf({
          kind,
          hasSecret: found.secret_ref !== null,
          state: found.state,
          lastOkAt,
          lastError: found.last_error,
        }),
        lastOkAt,
        lastError: found.last_error,
        lastErrorAt,
        deadLetters: Number(found.dead_letters ?? 0),
        installedAt: asDate(found.created_at),
        installedByName: found.installed_by_name,
        installedByEmail: found.installed_by_email,
        people: 0,
        // Whichever happened last. Computed rather than stored: two columns
        // already say it and a third would be one more thing to keep in step.
        lastActivityAt:
          lastOkAt && lastErrorAt ? (lastOkAt > lastErrorAt ? lastOkAt : lastErrorAt) : (lastOkAt ?? lastErrorAt),
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

/** The credential belongs to the account, so connecting one needs the account
 *  hub. Its trail lands in audit_log like every other decision; the separate
 *  organisation log it used to be written to went with migration 0058. */
export const saveIntegration = async (
  ctx: AccountContext,
  input: SaveIntegrationInput,
): Promise<{ id: string }> =>
  mutate(ctx, 'integration', async (tx) => {
    let secretRef = input.secret === undefined ? undefined : input.secret ? encryptToken(input.secret) : null
    if (secretRef === undefined && devIntegrations() && !KEYLESS_KINDS.has(input.kind)) {
      const [held] = await tx
        .select({ secretRef: integration.secretRef })
        .from(integration)
        .where(eq(integration.kind, input.kind))
      if (!held?.secretRef) secretRef = encryptToken(DEV_SECRET)
    }
    // Brevo does not sign its webhooks, and Woodpecker's signing header is not
    // documented, so the URL Rawr hands each of them carries a token compared on
    // every delivery.
    //
    // The token is the server's, never the caller's: minted once, read back from
    // the stored row on every later save, and ignored if it arrives in the input.
    // Taking it from the input would let whoever saves the integration choose the
    // value, and would rotate it to a new one every time somebody edited a config
    // field, silently breaking the URL already pasted at the provider.
    let config = input.config
    if (config !== undefined && (input.kind === 'brevo' || input.kind === 'woodpecker')) {
      const [existing] = await tx
        .select({ config: integration.config })
        .from(integration)
        .where(eq(integration.kind, input.kind))
      const held = (existing?.config as { webhookToken?: unknown } | null)?.webhookToken
      config = {
        ...config,
        webhookToken: typeof held === 'string' ? held : randomToken(24),
      }
    }

    const [saved] = await tx
      .insert(integration)
      .values({
        accountId: ctx.accountId,
        kind: input.kind,
        config: config ?? {},
        secretRef: secretRef ?? null,
        // Saved but never yet tested. The connection test is what moves it on.
        state: 'connected',
        lastError: null,
        lastErrorAt: null,
        installedBy: ctx.actorId,
      })
      .onConflictDoUpdate({
        target: [integration.accountId, integration.kind],
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
  ctx: AccountContext,
  kind: IntegrationKind,
): Promise<Credentials | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.select().from(integration).where(eq(integration.kind, kind)).limit(1)
    if (!row) return null
    return {
      id: row.id,
      config: (row.config ?? {}) as Record<string, unknown>,
      secret: row.secretRef ? decryptToken(row.secretRef) : null,
    }
  })

export const recordHealth = async (
  ctx: AccountContext,
  kind: IntegrationKind,
  outcome: { ok: true } | { ok: false; error: string; disconnected?: boolean },
): Promise<void> => {
  // Through the definer function, not a direct update: a health write is the one
  // change the app makes to this row without the account hub. Row level security is
  // row-level, so a policy permitting this update would equally permit one that
  // rewrote secret_ref. The function is the narrowing.
  //
  // A rejected credential is not a blip: it becomes 'revoked' rather than
  // 'degraded', so retries stop burning attempts against a decision already made
  // at the provider. F6's edge cases.
  await withAccount(ctx, async (tx) => {
    await tx.execute(sql`
      select rawr.record_integration_health(
        ${kind},
        ${outcome.ok},
        ${outcome.ok ? null : outcome.error.slice(0, 2000)},
        ${outcome.ok ? false : (outcome.disconnected ?? false)}
      )`)
  })
}

export const disconnectIntegration = async (
  ctx: AccountContext,
  kind: IntegrationKind,
): Promise<void> =>
  mutate(ctx, 'integration', async (tx) => {
    // The row's own id, not the kind: the audit log's entity_id is a uuid column,
    // and writing a name into it fails at the database rather than at the call.
    const [found] = await tx
      .select({ id: integration.id })
      .from(integration)
      .where(eq(integration.kind, kind))
      .limit(1)
    if (!found) throw new Error(`${kind} is not connected in this account.`)

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
  ctx: AccountContext,
  input: { key: string; operation: string; integrationId?: string | null },
  run: () => Promise<T>,
): Promise<CallOutcome<T>> => {
  const existing = await withAccount(ctx, async (tx) => {
    const [row] = await tx
      .select({ response: outboundCall.response })
      .from(outboundCall)
      .where(eq(outboundCall.idempotencyKey, input.key))
      .limit(1)
    return row
  })
  if (existing) return { fresh: false, response: existing.response as T }

  const response = await run()
  await recordOutboundCall(ctx, { ...input, response })

  return { fresh: true, response }
}

/** One row in the outbound ledger, and the only writer of it. Every provider call
 *  lands here, claimed under an idempotency key or not, which is what makes the
 *  "Calls out" panel a record of what Rawr did rather than of the two providers
 *  that happen to claim their calls.
 *
 *  O(1): one insert, and a key already taken is left alone rather than raising. */
export const recordOutboundCall = async (
  ctx: AccountContext,
  input: { key: string; operation: string; integrationId?: string | null; response?: unknown },
): Promise<void> => {
  await withAccount(ctx, async (tx) => {
    await tx
      .insert(outboundCall)
      .values({
        accountId: ctx.accountId,
        integrationId: input.integrationId ?? null,
        idempotencyKey: input.key,
        operation: input.operation,
        response: (input.response ?? null) as never,
      })
      .onConflictDoNothing()
  })
}

/** Inbound deduplication, the mirror of `once`. Returns false when this event has
 *  already been handled, so a provider that delivers twice is processed once. */
export const claimInbound = async (
  ctx: AccountContext,
  input: {
    source: string
    providerEventId: string
    kind: string
    payload: unknown
    contactId?: string | null
  },
): Promise<boolean> =>
  withAccount(ctx, async (tx) => {
    const [claimed] = await tx
      .insert(inboundEvent)
      .values({
        accountId: ctx.accountId,
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
  ctx: AccountContext,
  limit = 50,
): Promise<UnmatchedEvent[]> =>
  withAccount(ctx, (tx) =>
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
export const rematchInbound = async (ctx: AccountContext): Promise<{ matched: number }> => {
  assertCanWrite(ctx, 'integration')
  return withAccount(ctx, async (tx) => {
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
  ctx: AccountContext,
  input: { entity: string; entityId: string; fieldKey: string; source: FieldSourceKind; provider?: string | null },
): Promise<void> => {
  await tx
    .insert(fieldSource)
    .values({
      accountId: ctx.accountId,
      entity: input.entity,
      entityId: input.entityId,
      fieldKey: input.fieldKey,
      source: input.source,
      provider: input.provider ?? null,
    })
    .onConflictDoUpdate({
      target: [fieldSource.accountId, fieldSource.entity, fieldSource.entityId, fieldSource.fieldKey],
      set: { source: input.source, provider: input.provider ?? null, at: new Date() },
    })
}

export const readFieldSources = async (
  ctx: AccountContext,
  entity: string,
  entityId: string,
): Promise<Map<string, { source: FieldSourceKind; provider: string | null }>> =>
  withAccount(ctx, async (tx) => {
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
  ctx: AccountContext,
  entity?: string,
  entityId?: string,
): Promise<SuggestionRow[]> =>
  withAccount(ctx, (tx) =>
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

export const dismissSuggestion = async (ctx: AccountContext, id: string): Promise<void> => {
  // Dismissing is a decision about the record, so it takes the record's write role.
  assertCanWrite(ctx, 'contact')
  await withAccount(ctx, async (tx) => {
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
export type Replayable = { jobName: string; payload: unknown; accountId: string }

export const claimForReplay = async (ctx: AccountContext, id: string): Promise<Replayable> =>
  mutate(ctx, 'dead_letter', async (tx) => {
    // Somebody is dealing with the queue. The day's notice stops being unread
    // rather than sitting there until the retention sweep takes it.
    await resolveNotifications(tx, ctx, 'dead_letter:')
    const [row] = await tx
      .select({ jobName: deadLetter.jobName, payload: deadLetter.payload })
      .from(deadLetter)
      .where(and(eq(deadLetter.id, id), isNull(deadLetter.replayedAt)))
      .limit(1)
    if (!row) throw new Error('That failure has already been replayed, or it does not exist.')

    await tx.update(deadLetter).set({ replayedAt: new Date() }).where(eq(deadLetter.id, id))

    return {
      result: { jobName: row.jobName, payload: row.payload, accountId: ctx.accountId },
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
export const releaseReplay = async (ctx: AccountContext, id: string): Promise<void> => {
  await withAccount(ctx, async (tx) => {
    await tx.update(deadLetter).set({ replayedAt: null }).where(eq(deadLetter.id, id))
  })
}
