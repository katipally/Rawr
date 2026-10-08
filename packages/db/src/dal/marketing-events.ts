import { createHash } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { auditLog } from '../schema/identity.ts'
import { activity, activityLink, contact } from '../schema/records.ts'
import { subscriptionState, subscriptionType } from '../schema/marketing.ts'
import type { ActivityType } from './activity.ts'
import { assertCanView, type AccountContext } from './context.ts'
import { refreshEmailEngagement } from './engagement.ts'
import { withAccount, type Tx } from './index.ts'
import { claimInbound } from './integrations.ts'

/** F6 §2 and §3. What a provider tells us happened to an email, turned into a
 *  timeline entry on the right contact.
 *
 *  Three providers, one shape. Brevo reports what happened to a newsletter, Apollo
 *  reports what happened to a one-to-one send and where a sequence got to, and all
 *  of it is the same question on a record: what has this person done with our mail.
 *
 *  Matching is by email address. An event for an address nobody knows is stored
 *  against no contact and surfaced in the unmatched queue rather than dropped,
 *  because "nobody opened it" and "we could not tell who opened it" are different
 *  answers and only one of them is true. */

export type MarketingEventKind =
  | 'delivered'
  | 'open'
  | 'click'
  | 'bounce'
  | 'spam'
  | 'unsubscribe'
  | 'sequence_step'
  | 'sequence_reply'

export type MarketingEvent = {
  source: 'brevo' | 'apollo' | 'woodpecker'
  providerEventId: string
  kind: MarketingEventKind
  email: string
  subject: string | null
  at: Date
  detail: Record<string, unknown>
  /** Which subscription types an unsubscribe applies to, by name, case-insensitive.
   *  Absent or empty means every type that is not internal: a newsletter opt-out
   *  from a provider that only ever sent newsletters should not silence sales. */
  subscriptionTypes?: string[]
}

/** Which timeline type each event becomes. The three are distinct on purpose: a
 *  newsletter open and a one-to-one open are different questions, and a sequence
 *  step is neither. A3's type list. */
const ACTIVITY_TYPE: Record<MarketingEventKind, ActivityType> = {
  delivered: 'marketing_email',
  open: 'email_tracking',
  click: 'email_tracking',
  bounce: 'marketing_email',
  spam: 'marketing_email',
  unsubscribe: 'subscription_change',
  sequence_step: 'sequence_activity',
  sequence_reply: 'sequence_activity',
}

/** A sequence event names what happened (enrolled, completed, failed, removed,
 *  paused, resumed); the step number is the fallback when it does not. */
const sequenceSentence = (subject: string, detail: Record<string, unknown>): string => {
  const event = typeof detail.event === 'string' ? detail.event : ''
  const step = typeof detail.step === 'number' && detail.step > 0 ? ` (step ${detail.step})` : ''
  if (event === 'sent') return subject === 'a sequence' || !subject ? 'was sent an email' : `was sent ${subject}${step}`
  if (event === 'enrolled') return `was enrolled in ${subject}${step}`
  if (event === 'completed') return `finished ${subject}`
  if (event === 'failed') return `failed in ${subject}${detail.reason ? `: ${String(detail.reason)}` : ''}`
  if (event === 'removed') return `was removed from ${subject}`
  if (event === 'paused') return `was paused in ${subject}${detail.reason ? `: ${String(detail.reason)}` : ''}`
  if (event === 'resumed') return `was resumed in ${subject}`
  return `reached${step || ' a step'} in ${subject}`
}

const SENTENCE: Record<MarketingEventKind, (subject: string, detail: Record<string, unknown>) => string> = {
  delivered: (subject) => `was sent ${subject}`,
  open: (subject) => `opened ${subject}`,
  click: (subject) => `clicked a link in ${subject}`,
  bounce: (subject) => `did not receive ${subject}: it bounced`,
  spam: (subject) => `marked ${subject} as spam`,
  unsubscribe: () => 'unsubscribed',
  sequence_step: sequenceSentence,
  sequence_reply: (subject) => `replied to ${subject}`,
}

export type IngestOutcome = { stored: boolean; matched: boolean; reason: string | null }

/** A matched event in the shape the post-match write needs. Built from a live event
 *  at ingest and from a stored `inbound_event` row at rematch. */
export type MatchedEvent = {
  contactId: string
  source: string
  providerEventId: string
  kind: MarketingEventKind
  subject: string | null
  detail: Record<string, unknown>
  at: Date
  subscriptionTypes: string[]
}

export const MARKETING_EVENT_KINDS = Object.keys(ACTIVITY_TYPE) as MarketingEventKind[]

/** Rows per multi-row insert. Postgres caps one statement at 65,535 bind parameters,
 *  and the widest row here binds about ten. */
const WRITE_CHUNK = 1000

const inChunks = async <T>(rows: T[], write: (chunk: T[]) => Promise<unknown>): Promise<void> => {
  for (let from = 0; from < rows.length; from += WRITE_CHUNK) await write(rows.slice(from, from + WRITE_CHUNK))
}

/** Everything a matched marketing event writes: the timeline entry, the engagement
 *  refresh for sequence mail, and the opt-out for an unsubscribe. Ingest passes the
 *  one event it matched; rematch passes every event it matched. Set-based, so the
 *  statement count does not grow with the number of events.
 *
 *  The timeline row's id is derived from (account, source, provider event id), so a
 *  second write of the same event hits the primary key and does nothing. The opt-out
 *  audit row is not protected that way, so each event must reach this function once:
 *  the match that makes it visible runs in the same transaction, and only unmatched
 *  rows match. */
export const applyMatchedEvents = async (tx: Tx, ctx: AccountContext, events: MatchedEvent[]): Promise<void> => {
  if (events.length === 0) return

  const entries = events.map((event) => {
    // The account is part of the key: activity ids are global, and two accounts can
    // receive the same provider event id.
    const id = createHash('md5').update(`event:${ctx.accountId}:${event.source}:${event.providerEventId}`).digest('hex')
    return {
      activity: {
        id,
        accountId: ctx.accountId,
        type: ACTIVITY_TYPE[event.kind],
        subject: SENTENCE[event.kind](event.subject ?? 'an email', event.detail),
        occurredAt: event.at,
        actorId: ctx.actorId,
        actorKind: ctx.actorKind,
        payload: { source: event.source, kind: event.kind, ...event.detail },
      },
      link: {
        accountId: ctx.accountId,
        activityId: id,
        entityType: 'contact',
        entityId: event.contactId,
        type: ACTIVITY_TYPE[event.kind],
        occurredAt: event.at,
      },
    }
  })
  await inChunks(entries, (rows) => tx.insert(activity).values(rows.map((row) => row.activity)).onConflictDoNothing())
  await inChunks(entries, (rows) => tx.insert(activityLink).values(rows.map((row) => row.link)).onConflictDoNothing())

  await refreshEmailEngagement(
    tx,
    ctx,
    events.filter((event) => event.kind === 'sequence_step' || event.kind === 'sequence_reply').map((event) => event.contactId),
  )

  // An unsubscribe reported by a provider is authoritative for that provider's list,
  // and Rawr then refuses to include the contact in any future push. The reverse never
  // happens: a Rawr-originated opt-out is not overwritten by a provider claiming the
  // person is subscribed. F6 §2.
  const unsubscribes = events.filter((event) => event.kind === 'unsubscribe')
  if (unsubscribes.length === 0) return

  const types = await tx
    .select({ id: subscriptionType.id, name: subscriptionType.name, isInternal: subscriptionType.isInternal })
    .from(subscriptionType)
  const now = new Date()
  const optOuts = new Map<string, typeof subscriptionState.$inferInsert>()
  for (const event of unsubscribes) {
    const wanted = new Set(event.subscriptionTypes.map((name) => name.trim().toLowerCase()).filter(Boolean))
    for (const type of types) {
      if (wanted.size > 0 ? !wanted.has(type.name.toLowerCase()) : type.isInternal) continue
      optOuts.set(`${event.contactId}:${type.id}`, {
        accountId: ctx.accountId,
        contactId: event.contactId,
        subscriptionTypeId: type.id,
        state: 'unsubscribed',
        source: event.source,
        changedAt: now,
      })
    }
  }
  await inChunks([...optOuts.values()], (rows) =>
    tx
      .insert(subscriptionState)
      .values(rows)
      .onConflictDoUpdate({
        target: [subscriptionState.accountId, subscriptionState.contactId, subscriptionState.subscriptionTypeId],
        set: {
          state: 'unsubscribed',
          changedAt: sql`excluded.changed_at`,
          source: sql`excluded.source`,
        },
      }),
  )
  await inChunks(unsubscribes, (rows) =>
    tx.insert(auditLog).values(
      rows.map((event) => ({
        accountId: ctx.accountId,
        actorId: ctx.actorId,
        actorKind: ctx.actorKind,
        entity: 'subscription_state',
        entityId: event.contactId,
        action: 'set',
        before: { via: event.source },
        after: { state: 'unsubscribed', authoritative: true },
      })),
    ),
  )
}

export const ingestMarketingEvent = async (
  ctx: AccountContext,
  event: MarketingEvent,
): Promise<IngestOutcome> => {
  const email = event.email.trim().toLowerCase()
  if (!email.includes('@')) return { stored: false, matched: false, reason: 'The event named no address.' }

  return withAccount(ctx, async (tx) => {
    const [matchedContact] = await tx
      .select({ id: contact.id })
      .from(contact)
      .where(and(sql`lower(${contact.email}) = ${email}`, isNull(contact.deletedAt)))
      .limit(1)

    // Deduplicated on the provider's own event id, so a webhook delivered twice is
    // processed once. F6's edge-case table. Claim and timeline write share this
    // transaction, so a failed write leaves the event unclaimed for the retry.
    const subscriptionTypes = event.subscriptionTypes ?? []
    const claimed = await claimInbound(ctx, {
      source: event.source,
      providerEventId: event.providerEventId,
      kind: event.kind,
      payload: { ...event.detail, email, subject: event.subject, subscriptionTypes },
      contactId: matchedContact?.id ?? null,
      at: event.at,
    })
    if (!claimed) return { stored: false, matched: Boolean(matchedContact), reason: 'Already seen.' }

    if (!matchedContact) {
      return {
        stored: true,
        matched: false,
        reason: `No contact has the address ${email}, so this is in the unmatched queue.`,
      }
    }

    await applyMatchedEvents(tx, ctx, [
      {
        contactId: matchedContact.id,
        source: event.source,
        providerEventId: event.providerEventId,
        kind: event.kind,
        subject: event.subject,
        detail: event.detail,
        at: event.at,
        subscriptionTypes,
      },
    ])
    return { stored: true, matched: true, reason: null }
  })
}

/** Who may be included in a list push. The one query F6 §2's promise rests on:
 *  nobody whose latest state anywhere is unsubscribed is ever mailed again. */
export const mailableContacts = async (
  ctx: AccountContext,
  contactIds: string[],
): Promise<{ id: string; email: string; firstName: string | null; lastName: string | null }[]> => {
  if (contactIds.length === 0) return []
  return withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      email: string
      first_name: string | null
      last_name: string | null
    }>(sql`
      select c.id, c.email, c.first_name, c.last_name
        from contact c
       where c.deleted_at is null
         and c.email is not null
         and c.id in (${sql.join(contactIds.map((id) => sql`${id}`), sql`, `)})
         and not exists (
           select 1 from subscription_state s
            where s.contact_id = c.id and s.state = 'unsubscribed')`)
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
    }))
  })
}

/** One page of a contact segment, for a list push that must not stop early.
 *
 *  `mailableContacts` above answers the same question for a set of ids the caller
 *  already holds, which is fine for a record page and wrong for a segment: an
 *  `in (...)` list of every member is one enormous statement, and reading the
 *  members first caps the push at whatever that read caps at. This walks instead.
 *
 *  A member with no address or an opt-out is still returned, carrying
 *  `mailable: false`, so the caller can say how many it left out without a second
 *  count over the same rows. The cursor is the contact id rather than the join's
 *  `entered_at`, because two people can enter a segment in the same millisecond
 *  and a push that skips one of them is the bug this function exists to fix. */
export type SegmentContact = {
  id: string
  email: string | null
  firstName: string | null
  lastName: string | null
  mailable: boolean
}

export const readSegmentContactPage = async (
  ctx: AccountContext,
  segmentId: string,
  input: { after?: string | null; limit?: number } = {},
): Promise<{ rows: SegmentContact[]; nextCursor: string | null }> => {
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000)
  return withAccount(ctx, async (tx) => {
    const [found] = await tx.execute<{ object_key: string }>(sql`
      select o.key as object_key
        from segment s join object_def o on o.id = s.object_id
       where s.id = ${segmentId}`)
    if (!found) throw new Error('That segment no longer exists.')
    if (found.object_key !== 'contact') {
      throw new Error('That segment is not a contact segment, so there is nobody in it to mail.')
    }

    const rows = await tx.execute<{
      id: string
      email: string | null
      first_name: string | null
      last_name: string | null
      mailable: boolean
    }>(sql`
      select c.id, c.email, c.first_name, c.last_name,
             (c.email is not null and not exists (
                select 1 from subscription_state s
                 where s.contact_id = c.id and s.state = 'unsubscribed')) as mailable
        from segment_membership m
        join contact c on c.id = m.entity_id
       where m.segment_id = ${segmentId}
         and m.exited_at is null
         and c.deleted_at is null
         ${input.after ? sql`and c.id > ${input.after}` : sql``}
       order by c.id
       limit ${limit + 1}`)

    const page = rows.slice(0, limit)
    return {
      rows: page.map((row) => ({
        id: String(row.id),
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
        mailable: row.mailable === true,
      })),
      nextCursor: rows.length > limit && page.at(-1) ? String(page.at(-1)!.id) : null,
    }
  })
}

/** Per segment, how many members a list push would mail: the same `mailable` test
 *  `readSegmentContactPage` applies, counted in one grouped aggregate over every
 *  segment's live memberships (M rows, each a primary-key probe on contact and an
 *  index probe on subscription_state by contact_id, so O(M log N)). listSegments
 *  already scans the same memberships for its counts. */
export const countMailableBySegment = async (ctx: AccountContext): Promise<Map<string, number>> =>
  withAccount(ctx, async (tx) => {
    assertCanView(ctx, 'contacts', 'segments')
    const rows = await tx.execute<{ segment_id: string; n: number }>(sql`
      select m.segment_id, count(*)::int as n
        from segment_membership m
        join contact c on c.id = m.entity_id
       where m.exited_at is null
         and c.deleted_at is null
         and c.email is not null
         and not exists (
           select 1 from subscription_state s
            where s.contact_id = c.id and s.state = 'unsubscribed')
       group by m.segment_id`)
    return new Map(rows.map((row) => [String(row.segment_id), Number(row.n)]))
  })

/** The provider's own id for this contact, so a sync is incremental rather than a
 *  full re-push and an opt-out reaches the right row at the other end. */
export const setExternalId = async (
  ctx: AccountContext,
  contactId: string,
  provider: string,
  externalId: string,
): Promise<void> => {
  await withAccount(ctx, async (tx) => {
    await tx
      .update(contact)
      .set({
        externalIds: sql`coalesce(${contact.externalIds}, '{}'::jsonb) || ${JSON.stringify({ [provider]: externalId })}::jsonb`,
      })
      .where(eq(contact.id, contactId))
  })
}

export const externalIdOf = async (
  ctx: AccountContext,
  contactId: string,
  provider: string,
): Promise<string | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{ external_id: string | null }>(sql`
      select external_ids ->> ${provider} as external_id from contact
       where id = ${contactId} and deleted_at is null limit 1`)
    return row?.external_id ?? null
  })

/** Contacts a provider knows, oldest-synced first, so a scheduled read-back walks
 *  the whole set over a few passes rather than the same few every time. */
export const contactsLinkedTo = async (
  ctx: AccountContext,
  provider: string,
  limit: number,
): Promise<{ id: string; email: string; externalId: string }[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{ id: string; email: string; external_id: string }>(sql`
      select c.id, c.email, c.external_ids ->> ${provider} as external_id
        from contact c
       where c.deleted_at is null and c.email is not null
         and c.external_ids ? ${provider}
       order by coalesce((c.external_ids ->> ${provider + ':synced_at'})::timestamptz, 'epoch'::timestamptz)
       limit ${limit}`)
    return rows.map((row) => ({ id: row.id, email: row.email, externalId: row.external_id }))
  })
