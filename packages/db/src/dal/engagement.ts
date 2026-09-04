import { sql } from 'drizzle-orm'
import type { WorkspaceContext } from './context.ts'
import type { Tx } from './index.ts'

/** The four email engagement numbers on a contact, recomputed from what is
 *  stored rather than incremented, so a deleted note or a re-read thread cannot
 *  leave them drifting. Called inside the transaction that changed the inputs.
 *
 *  Sources, in HubSpot's terms:
 *    last contacted   an outbound Gmail message to them, a call, meeting or email
 *                     logged by hand, or an Apollo sequence send
 *    last reply       an inbound Gmail message from them, or an Apollo reply
 *    emails sent      outbound Gmail messages plus Apollo sequence sends
 *    emails received  inbound Gmail messages
 *
 *  One statement per call, however many contacts: O(messages of those contacts). */
export const refreshEmailEngagement = async (tx: Tx, _ctx: WorkspaceContext, contactIds: string[]): Promise<void> => {
  const ids = [...new Set(contactIds)].filter(Boolean)
  if (ids.length === 0) return
  await tx.execute(sql`
    with wanted as (select unnest(array[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]) as id),
    outbound as (
      select p.contact_id, count(*)::int as n, max(m.sent_at) as last_at
        from message_participant p join message m on m.id = p.message_id
       where p.contact_id in (select id from wanted) and p.role in ('to', 'cc') and m.direction = 'outbound'
       group by p.contact_id),
    inbound as (
      select p.contact_id, count(*)::int as n, max(m.sent_at) as last_at
        from message_participant p join message m on m.id = p.message_id
       where p.contact_id in (select id from wanted) and p.role = 'from' and m.direction = 'inbound'
       group by p.contact_id),
    touches as (
      select l.entity_id as contact_id,
             max(a.occurred_at) filter (where a.type in ('call', 'meeting') or (a.type = 'email' and coalesce(a.payload ->> 'direction', 'outbound') <> 'inbound') or (a.type = 'sequence_activity' and a.payload ->> 'event' in ('sent', 'enrolled'))) as last_touch,
             max(a.occurred_at) filter (where a.type = 'sequence_activity' and a.payload ->> 'event' = 'replied') as last_reply,
             count(*) filter (where a.type = 'sequence_activity' and a.payload ->> 'event' = 'sent')::int as sequence_sent
        from activity_link l join activity a on a.id = l.activity_id
       where l.entity_type = 'contact' and l.entity_id in (select id from wanted)
       group by l.entity_id)
    update contact c
       set last_contacted_at = greatest(o.last_at, t.last_touch),
           last_replied_at = greatest(i.last_at, t.last_reply),
           emails_sent = coalesce(o.n, 0) + coalesce(t.sequence_sent, 0),
           emails_received = coalesce(i.n, 0)
      from wanted w
      left join outbound o on o.contact_id = w.id
      left join inbound i on i.contact_id = w.id
      left join touches t on t.contact_id = w.id
     where c.id = w.id`)
}

export type EmailEngagement = {
  lastContactedAt: Date | null
  lastRepliedAt: Date | null
  emailsSent: number
  emailsReceived: number
  /** Days since the last outbound touch with no reply after it. Null when there is
   *  nothing outstanding: never contacted, or they answered last. */
  awaitingReplyDays: number | null
}

export const readEmailEngagement = (values: Record<string, unknown>): EmailEngagement => {
  const at = (value: unknown): Date | null => (value instanceof Date ? value : typeof value === 'string' && value ? new Date(value) : null)
  const lastContactedAt = at(values.last_contacted_at)
  const lastRepliedAt = at(values.last_replied_at)
  const outstanding = lastContactedAt && (!lastRepliedAt || lastRepliedAt < lastContactedAt)
  return {
    lastContactedAt,
    lastRepliedAt,
    emailsSent: Number(values.emails_sent ?? 0),
    emailsReceived: Number(values.emails_received ?? 0),
    awaitingReplyDays: outstanding && lastContactedAt ? Math.floor((Date.now() - lastContactedAt.getTime()) / 86_400_000) : null,
  }
}
