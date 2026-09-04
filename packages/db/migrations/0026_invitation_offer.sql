-- The invitation page runs before anybody has signed in, so there is no scope to
-- pin and the table's policy correctly showed it nothing. Reading an offer is the
-- same shape of question as "which workspaces does this person belong to": it has
-- to be answered above row level security, by a function that takes one opaque
-- token and returns only what that token is for.
--
-- It returns no ids, no inviter, and nobody else's address: enough to say who is
-- being invited to what, because an invitation link ends up in mail and mail gets
-- forwarded.

CREATE OR REPLACE FUNCTION rawr.invitation_offer(p_token_hash text)
  RETURNS TABLE (
    email text,
    organisation_name text,
    workspace_name text,
    expired boolean
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT i.email, o.name, w.name, (i.expires_at <= now())
      FROM public.invitation i
      JOIN public.organisation o ON o.id = i.organisation_id
      LEFT JOIN public.workspace w ON w.id = i.workspace_id
     WHERE i.token_hash = p_token_hash
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
     LIMIT 1
$$;
REVOKE ALL ON FUNCTION rawr.invitation_offer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.invitation_offer(text) TO rawr_app;
