-- A pixel, a click and an unsubscribe arrive from a stranger's mail client: no
-- session, no scope, and the tables they name are all workspace-scoped, so row
-- level security correctly shows them nothing.
--
-- The same shape of answer the analytics collector already needs, and the same
-- shape of function: one opaque token in, one workspace id out, nothing else. A
-- token is 24 random bytes, so guessing one is not a way in, and the id on its own
-- opens nothing without a session.

CREATE OR REPLACE FUNCTION rawr.workspace_for_send_token(p_token text)
  RETURNS TABLE (id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT d.workspace_id FROM public.sequence_send d WHERE d.token = p_token LIMIT 1
$$;
REVOKE ALL ON FUNCTION rawr.workspace_for_send_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.workspace_for_send_token(text) TO rawr_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.workspace_for_link_token(p_token text)
  RETURNS TABLE (id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT l.workspace_id FROM public.sequence_link l WHERE l.token = p_token LIMIT 1
$$;
REVOKE ALL ON FUNCTION rawr.workspace_for_link_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.workspace_for_link_token(text) TO rawr_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.workspace_for_unsubscribe_token(p_token text)
  RETURNS TABLE (id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT e.workspace_id FROM public.sequence_enrollment e WHERE e.unsubscribe_token = p_token LIMIT 1
$$;
REVOKE ALL ON FUNCTION rawr.workspace_for_unsubscribe_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.workspace_for_unsubscribe_token(text) TO rawr_app;
