import { and, eq, isNull, sql } from 'drizzle-orm'
import { contact } from '../schema/records.ts'
import { subscriptionState, subscriptionType } from '../schema/marketing.ts'
import { recordActivity, type ActivityType } from './activity.ts'
import type { WorkspaceContext } from './context.ts'
import { withWorkspace, writeAudit } from './index.ts'
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
  source: 'brevo' | 'apollo'
  providerEventId: string
  kind: MarketingEventKind
  email: string
  subject: string | null
  at: Date
  detail: Record<string, unknown>
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

const SENTENCE: Record<MarketingEventKind, (subject: string) => string> = {
  delivered: (subject) => `${subject} was delivered`,
  open: (subject) => `opened ${subject}`,
  click: (subject) => `clicked a link in ${subject}`,
  bounce: (subject) => `${subject} bounced`,
  spam: (subject) => `${subject} was marked as spam`,
  unsubscribe: () => 'unsubscribed',
  sequence_step: (subject) => `reached a step in ${subject}`,
  sequence_reply: (subject) => `replied to ${subject}`,
}

export type IngestOutcome = { stored: boolean; matched: boolean; reason: string | null }

export const ingestMarketingEvent = async (
  ctx: WorkspaceContext,
  event: MarketingEvent,
): Promise<IngestOutcome> => {
  const email = event.email.trim().toLowerCase()
  if (!email.includes('@')) return { stored: false, matched: false, reason: 'The event named no address.' }

  const matchedContact = await withWorkspace(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: contact.id })
      .from(contact)
      .where(and(sql`lower(${contact.email}) = ${email}`, isNull(contact.deletedAt)))
      .limit(1)
    return row ?? null
  })

  // Deduplicated on the provider's own event id, so a webhook delivered twice is
  // processed once. F6's edge-case table.
  const claimed = await claimInbound(ctx, {
    source: event.source,
    providerEventId: event.providerEventId,
    kind: event.kind,
    payload: { ...event.detail, email, subject: event.subject },
    contactId: matchedContact?.id ?? null,
  })
  if (!claimed) return { stored: false, matched: Boolean(matchedContact), reason: 'Already seen.' }

  if (!matchedContact) {
    return {
      stored: true,
      matched: false,
      reason: `No contact has the address ${email}, so this is in the unmatched queue.`,
    }
  }

  await withWorkspace(ctx, async (tx) => {
    const subject = event.subject ?? 'an email'
    await recordActivity(tx, ctx, {
      type: ACTIVITY_TYPE[event.kind],
      subject: SENTENCE[event.kind](subject),
      occurredAt: event.at,
      payload: { source: event.source, kind: event.kind, ...event.detail },
      links: [{ entityType: 'contact', entityId: matchedContact.id }],
    })

    // An unsubscribe reported by a provider is authoritative for that provider's
    // list, and Rawr then refuses to include the contact in any future push. The
    // reverse never happens: a Rawr-originated opt-out is not overwritten by a
    // provider claiming the person is subscribed. F6 §2.
    if (event.kind === 'unsubscribe') {
      const types = await tx.select({ id: subscriptionType.id, name: subscriptionType.name }).from(subscriptionType)
      for (const type of types) {
        if (type.name.toLowerCase().includes('internal')) continue
        await tx
          .insert(subscriptionState)
          .values({
            workspaceId: ctx.workspaceId,
            contactId: matchedContact.id,
            subscriptionTypeId: type.id,
            state: 'unsubscribed',
            source: event.source,
          })
          .onConflictDoUpdate({
            target: [subscriptionState.workspaceId, subscriptionState.contactId, subscriptionState.subscriptionTypeId],
            set: { state: 'unsubscribed', changedAt: new Date(), source: event.source },
          })
      }
      await writeAudit(tx, ctx, {
        entity: 'subscription_state',
        entityId: matchedContact.id,
        action: 'set',
        before: { via: event.source },
        after: { state: 'unsubscribed', authoritative: true },
      })
    }
  })

  return { stored: true, matched: true, reason: null }
}

/** Who may be included in a list push. The one query F6 §2's promise rests on:
 *  nobody whose latest state anywhere is unsubscribed is ever mailed again. */
export const mailableContacts = async (
  ctx: WorkspaceContext,
  contactIds: string[],
): Promise<{ id: string; email: string; firstName: string | null; lastName: string | null }[]> => {
  if (contactIds.length === 0) return []
  return withWorkspace(ctx, async (tx) => {
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

/** The provider's own id for this contact, so a sync is incremental rather than a
 *  full re-push and an opt-out reaches the right row at the other end. */
export const setExternalId = async (
  ctx: WorkspaceContext,
  contactId: string,
  provider: string,
  externalId: string,
): Promise<void> => {
  await withWorkspace(ctx, async (tx) => {
    await tx
      .update(contact)
      .set({
        externalIds: sql`coalesce(${contact.externalIds}, '{}'::jsonb) || ${JSON.stringify({ [provider]: externalId })}::jsonb`,
      })
      .where(eq(contact.id, contactId))
  })
}
