-- Email engagement on a contact, the four numbers HubSpot keeps as "Last
-- contacted", "Last engagement", "Number of times contacted": derived from the
-- mail Gmail sync stored, the calls, meetings and emails logged by hand, and the
-- sequence sends and replies Apollo reports. Maintained on every write that could
-- move them, so a view can sort and a segment can filter on "no reply in 14 days"
-- without a join over the message table.

ALTER TABLE public.contact
  ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_replied_at timestamptz,
  ADD COLUMN IF NOT EXISTS emails_sent integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS emails_received integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_last_contacted_idx ON public.contact (workspace_id, last_contacted_at DESC NULLS LAST);
--> statement-breakpoint

-- Every workspace that already exists gets the four fields in its registry, in
-- the same shape the seed writes them. A workspace seeded after this reads them
-- from CORE_OBJECTS instead.
INSERT INTO public.field_def (workspace_id, object_id, key, label, type, storage, column_name, is_custom, position)
SELECT o.workspace_id, o.id, f.key, f.label, f.type::public.rawr_field_type, 'column', f.key, false, f.position
  FROM public.object_def o
  CROSS JOIN (VALUES
    ('last_contacted_at', 'Last contacted', 'datetime', 15),
    ('last_replied_at', 'Last reply', 'datetime', 16),
    ('emails_sent', 'Emails sent', 'number', 17),
    ('emails_received', 'Emails received', 'number', 18)
  ) AS f(key, label, type, position)
 WHERE o.key = 'contact'
   AND NOT EXISTS (SELECT 1 FROM public.field_def d WHERE d.object_id = o.id AND d.key = f.key);
--> statement-breakpoint

-- One pass over what is already stored, so the numbers are right on the day
-- rather than only for mail that arrives afterwards. The same statement the
-- data layer runs per contact, over every contact once.
WITH outbound AS (
  SELECT p.contact_id, count(*)::int AS n, max(m.sent_at) AS last_at
    FROM public.message_participant p JOIN public.message m ON m.id = p.message_id
   WHERE p.contact_id IS NOT NULL AND p.role IN ('to', 'cc') AND m.direction = 'outbound'
   GROUP BY p.contact_id
), inbound AS (
  SELECT p.contact_id, count(*)::int AS n, max(m.sent_at) AS last_at
    FROM public.message_participant p JOIN public.message m ON m.id = p.message_id
   WHERE p.contact_id IS NOT NULL AND p.role = 'from' AND m.direction = 'inbound'
   GROUP BY p.contact_id
), touches AS (
  SELECT l.entity_id AS contact_id,
         max(a.occurred_at) FILTER (WHERE a.type IN ('call', 'meeting') OR (a.type = 'email' AND coalesce(a.payload ->> 'direction', 'outbound') <> 'inbound') OR (a.type = 'sequence_activity' AND a.payload ->> 'event' IN ('sent', 'enrolled'))) AS last_touch,
         max(a.occurred_at) FILTER (WHERE a.type = 'sequence_activity' AND a.payload ->> 'event' = 'replied') AS last_reply,
         count(*) FILTER (WHERE a.type = 'sequence_activity' AND a.payload ->> 'event' = 'sent')::int AS sequence_sent
    FROM public.activity_link l JOIN public.activity a ON a.id = l.activity_id
   WHERE l.entity_type = 'contact'
   GROUP BY l.entity_id
)
UPDATE public.contact c
   SET last_contacted_at = greatest(o.last_at, t.last_touch),
       last_replied_at = greatest(i.last_at, t.last_reply),
       emails_sent = coalesce(o.n, 0) + coalesce(t.sequence_sent, 0),
       emails_received = coalesce(i.n, 0)
  FROM public.contact x
  LEFT JOIN outbound o ON o.contact_id = x.id
  LEFT JOIN inbound i ON i.contact_id = x.id
  LEFT JOIN touches t ON t.contact_id = x.id
 WHERE x.id = c.id AND (o.contact_id IS NOT NULL OR i.contact_id IS NOT NULL OR t.contact_id IS NOT NULL);
