-- A thread carries the subject and the dates of its mail, and a thread row had
-- only the account-wide policy. A seat that could not read a private mailbox's
-- messages still read what they were about. The thread now follows its mail, and
-- a read marker is read and written by the person it belongs to.
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
