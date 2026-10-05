-- A mailbox marked private hid its threads from the shared inbox, and nothing
-- else: the email was also written to every matched contact's timeline as an
-- activity row, and a timeline row has only the account-wide policy. Anybody who
-- could open the contact read the subject and the opening lines of mail they were
-- told was not shared.
--
-- The activity and its links now carry the mailbox that produced them, and the
-- policy on them, on the messages and on everything hanging off a message asks
-- which private mailboxes this seat may not read. Row level, so the timeline, the
-- search, the counts, the exporter and an agent token all meet it.
ALTER TABLE public.activity
  ADD COLUMN IF NOT EXISTS mailbox_id uuid REFERENCES public.mailbox (id) ON DELETE SET NULL;
--> statement-breakpoint
-- Copied onto the link for the reason type and occurred_at are: the timeline and
-- its counts read the link alone and must not need the activity to decide.
ALTER TABLE public.activity_link
  ADD COLUMN IF NOT EXISTS mailbox_id uuid REFERENCES public.mailbox (id) ON DELETE SET NULL;
--> statement-breakpoint

UPDATE public.activity a
   SET mailbox_id = m.mailbox_id
  FROM public.message m
 WHERE a.type = 'email'
   AND a.mailbox_id IS NULL
   AND m.mailbox_id IS NOT NULL
   AND a.payload ->> 'messageId' = m.id::text;
--> statement-breakpoint
UPDATE public.activity_link l
   SET mailbox_id = a.mailbox_id
  FROM public.activity a
 WHERE l.activity_id = a.id
   AND a.mailbox_id IS NOT NULL;
--> statement-breakpoint

-- Private is what a newly connected mailbox is until its owner shares it. A
-- mailbox that was connected before this keeps what it was set to.
ALTER TABLE public.mailbox ALTER COLUMN visibility SET DEFAULT 'private';
--> statement-breakpoint

-- The private mailboxes this seat may not read: everybody else's, unless the seat
-- is a super admin or holds the account hub, who administer them. A session with
-- no actor (the worker syncing a mailbox) hides nothing. An array rather than a
-- per-row test so the policy can read it once per statement.
CREATE OR REPLACE FUNCTION rawr.hidden_mailboxes()
RETURNS uuid[]
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN rawr.current_actor() IS NULL THEN ARRAY[]::uuid[]
    WHEN EXISTS (
      SELECT 1 FROM public.membership m
       WHERE m.account_id = rawr.current_account()
         AND m.user_id = rawr.current_actor()
         AND m.state = 'active'
         AND (m.is_super_admin OR m.edit_hubs @> ARRAY['account'::public.rawr_hub])
    ) THEN ARRAY[]::uuid[]
    ELSE COALESCE((
      SELECT array_agg(mb.id) FROM public.mailbox mb
       WHERE mb.account_id = rawr.current_account()
         AND mb.visibility = 'private'
         AND mb.user_id IS DISTINCT FROM rawr.current_actor()
    ), ARRAY[]::uuid[])
  END
$$;
--> statement-breakpoint

-- 0059's function with one more predicate on reads. Applied to USING only: a
-- thread, a message or an activity is inserted before anything points at it, and
-- the new row must be allowed to exist whatever it will later be hidden from.
CREATE OR REPLACE FUNCTION rawr.apply_tenancy()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  t record;
  applied int := 0;
  hub text;
  using_expr text;
  check_expr text;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
                         AND a.attname = 'account_id'
                         AND a.attnum > 0
                         AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  LOOP
    hub := CASE t.relname
             WHEN 'contact' THEN 'contacts'
             WHEN 'company' THEN 'contacts'
             WHEN 'custom_record' THEN 'contacts'
             WHEN 'deal' THEN 'sales'
             ELSE NULL
           END;

    using_expr := 'account_id = rawr.current_account()';
    check_expr := using_expr;
    IF hub IS NOT NULL THEN
      -- A scalar subquery with no outer reference becomes an InitPlan and runs
      -- once for the statement; a bare STABLE function in a filter runs per row
      -- (measured: 53us a row). The cast is load bearing: `ANY(<bare subquery>)`
      -- is read as the set form and fails on uuid = uuid[].
      using_expr := using_expr || format(
        ' AND coalesce(owner_id = ANY((SELECT rawr.visible_owners(%L, false))::uuid[]), true)', hub);
      check_expr := check_expr || format(
        ' AND coalesce(owner_id = ANY((SELECT rawr.visible_owners(%L, true))::uuid[]), true)', hub);
    END IF;

    IF t.relname IN ('message', 'activity', 'activity_link') THEN
      using_expr := using_expr ||
        ' AND coalesce(mailbox_id <> ALL((SELECT rawr.hidden_mailboxes())::uuid[]), true)';
    ELSIF t.relname IN ('message_body', 'message_attachment', 'message_participant') THEN
      using_expr := using_expr ||
        ' AND EXISTS (SELECT 1 FROM public.message m WHERE m.id = message_id)';
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS rawr_tenant ON public.%I', t.relname);
    EXECUTE format('CREATE POLICY rawr_tenant ON public.%I USING (%s) WITH CHECK (%s)',
                   t.relname, using_expr, check_expr);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO rawr_app', t.relname);
    applied := applied + 1;
  END LOOP;

  -- Append only. History cannot be rewritten even with a valid session.
  REVOKE UPDATE, DELETE ON public.audit_log FROM rawr_app;

  RETURN applied;
END
$$;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
