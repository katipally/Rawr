-- Record scope (own, team, everything) was applied to four tables. The timeline,
-- the tasks, the mail, the files, the list memberships and the notices that hang
-- off a record were account wide, so a seat narrowed to its own records still read
-- everything said about the ones it could not open.
--
-- Each of them now asks the record it belongs to. The lookup is a function that
-- reads the parent tables past their own policy, because a policy that selected
-- from a table whose policy selects back from it is refused as recursive, and
-- because "this thing belongs to a record I may not see" cannot be asked of rows
-- the policy has already hidden. It answers with the parent policy's own rule
-- (`owner_id` in the seat's visible owners), and says "not hidden" for anything
-- that is not a record, so a notice about a task or a booking is untouched.
--
-- Cost: a seat that is not narrowed (a super admin, scope everything, the worker,
-- a token with no actor) evaluates one statement-level flag and nothing per row.
-- A narrowed seat pays one primary key probe per row a statement reads.

-- Whether this seat is narrowed on either record hub, or holds neither. A scalar
-- subquery in a policy runs once per statement.
CREATE OR REPLACE FUNCTION rawr.scoped()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT rawr.visible_owners('contacts', false) IS NOT NULL
      OR rawr.visible_owners('sales', false) IS NOT NULL
$$;
--> statement-breakpoint

-- True when the id is a record in this account that this seat may not read.
CREATE OR REPLACE FUNCTION rawr.record_hidden(entity_type text, entity_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE entity_type
    WHEN 'contact' THEN EXISTS (
      SELECT 1 FROM public.contact r
       WHERE r.id = entity_id AND r.account_id = rawr.current_account()
         AND NOT coalesce(r.owner_id = ANY(rawr.visible_owners('contacts', false)), true))
    WHEN 'company' THEN EXISTS (
      SELECT 1 FROM public.company r
       WHERE r.id = entity_id AND r.account_id = rawr.current_account()
         AND NOT coalesce(r.owner_id = ANY(rawr.visible_owners('contacts', false)), true))
    WHEN 'deal' THEN EXISTS (
      SELECT 1 FROM public.deal r
       WHERE r.id = entity_id AND r.account_id = rawr.current_account()
         AND NOT coalesce(r.owner_id = ANY(rawr.visible_owners('sales', false)), true))
    ELSE EXISTS (
      SELECT 1 FROM public.custom_record r
       WHERE r.id = entity_id AND r.account_id = rawr.current_account()
         AND NOT coalesce(r.owner_id = ANY(rawr.visible_owners('contacts', false)), true))
  END
$$;
--> statement-breakpoint

-- A message is about the contacts on it. Hidden when it names at least one and this
-- seat may read none of them; mail that matched nobody belongs to no record.
CREATE OR REPLACE FUNCTION rawr.message_hidden(message_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.message_participant p
            WHERE p.message_id = message_hidden.message_id
              AND p.account_id = rawr.current_account() AND p.contact_id IS NOT NULL)
     AND NOT EXISTS (
           SELECT 1 FROM public.message_participant p
             JOIN public.contact c ON c.id = p.contact_id
            WHERE p.message_id = message_hidden.message_id
              AND p.account_id = rawr.current_account() AND c.account_id = rawr.current_account()
              AND coalesce(c.owner_id = ANY(rawr.visible_owners('contacts', false)), true))
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.record_hidden(text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.record_hidden(text, uuid) TO rawr_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rawr.message_hidden(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.message_hidden(uuid) TO rawr_app;
--> statement-breakpoint

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
  select_expr text;
  split boolean;
  scope_expr text;
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
    select_expr := NULL;
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
    ELSIF t.relname = 'message_thread' THEN
      -- Its subject and dates are the mail's. Read when this seat hides no mailbox,
      -- when the thread has no mail yet (it is inserted before its first message),
      -- or when it holds a message this seat may read. The subquery meets the
      -- message policy, so hidden mail does not count. Reads only: a second
      -- private mailbox on the same conversation must still be able to store its
      -- own message onto the thread it cannot read yet.
      select_expr := using_expr ||
        ' AND (cardinality((SELECT rawr.hidden_mailboxes())::uuid[]) = 0 OR message_count = 0' ||
        ' OR EXISTS (SELECT 1 FROM public.message m WHERE m.thread_id = message_thread.id))';
    ELSIF t.relname = 'message_thread_read' THEN
      -- How far somebody has read is theirs alone, to see and to write.
      using_expr := using_expr || ' AND coalesce(user_id = rawr.current_actor(), true)';
      check_expr := check_expr || ' AND coalesce(user_id = rawr.current_actor(), true)';
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS rawr_tenant ON public.%I', t.relname);
    -- What hangs off a record is judged by the record. A seat narrowed to its own
    -- or its team's records reads the timeline, the tasks, the mail, the files,
    -- the list memberships and the notices of those records and no others. A
    -- seat that is not narrowed pays one statement-level flag and no per-row work.
    scope_expr := CASE t.relname
      WHEN 'activity_link' THEN 'NOT rawr.record_hidden(entity_type, entity_id)'
      WHEN 'attachment' THEN 'NOT rawr.record_hidden(entity_type, entity_id)'
      WHEN 'association' THEN 'NOT rawr.record_hidden(from_type, from_id) AND NOT rawr.record_hidden(to_type, to_id)'
      -- Its own author, or any record it hangs on that this seat may read. The
      -- author clause is also what lets the row be inserted and returned before
      -- its links exist.
      WHEN 'activity' THEN 'actor_id = (SELECT rawr.current_actor()) OR EXISTS (SELECT 1 FROM public.activity_link l WHERE l.activity_id = activity.id)'
      WHEN 'task' THEN 'entity_id IS NULL OR assignee_id = (SELECT rawr.current_actor()) OR NOT rawr.record_hidden(entity_type, entity_id)'
      WHEN 'message' THEN 'NOT rawr.message_hidden(id) OR mailbox_id = ANY((SELECT coalesce(array_agg(mb.id), ARRAY[]::uuid[]) FROM public.mailbox mb WHERE mb.user_id = rawr.current_actor())::uuid[])'
      WHEN 'segment_membership' THEN 'NOT rawr.record_hidden((SELECT od.key FROM public.segment sg JOIN public.object_def od ON od.id = sg.object_id WHERE sg.id = segment_membership.segment_id), entity_id)'
      WHEN 'notification' THEN 'entity_id IS NULL OR NOT rawr.record_hidden(entity, entity_id)'
      ELSE NULL
    END;
    IF scope_expr IS NOT NULL THEN
      using_expr := using_expr || ' AND (NOT (SELECT rawr.scoped()) OR ' || scope_expr || ')';
    END IF;

    split := hub IS NOT NULL OR select_expr IS NOT NULL;
    select_expr := coalesce(select_expr, using_expr);
    IF NOT split THEN
      EXECUTE format('CREATE POLICY rawr_tenant ON public.%I USING (%s) WITH CHECK (%s)',
                     t.relname, using_expr, check_expr);
    ELSE
      EXECUTE format('DROP POLICY IF EXISTS rawr_tenant_select ON public.%I', t.relname);
      EXECUTE format('DROP POLICY IF EXISTS rawr_tenant_insert ON public.%I', t.relname);
      EXECUTE format('DROP POLICY IF EXISTS rawr_tenant_update ON public.%I', t.relname);
      EXECUTE format('DROP POLICY IF EXISTS rawr_tenant_delete ON public.%I', t.relname);
      EXECUTE format('CREATE POLICY rawr_tenant_select ON public.%I FOR SELECT USING (%s)', t.relname, select_expr);
      EXECUTE format('CREATE POLICY rawr_tenant_insert ON public.%I FOR INSERT WITH CHECK (%s)', t.relname, check_expr);
      EXECUTE format('CREATE POLICY rawr_tenant_update ON public.%I FOR UPDATE USING (%s) WITH CHECK (%s)',
                     t.relname, using_expr, check_expr);
      EXECUTE format('CREATE POLICY rawr_tenant_delete ON public.%I FOR DELETE USING (%s)', t.relname, check_expr);
    END IF;
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
