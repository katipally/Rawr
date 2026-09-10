-- The acts HubSpot marks Critical, granted per seat on top of the hub grid.
--
-- HubSpot's per-user editor (measured Sep 10 2026) puts View / Create / Edit on
-- one line and then Delete, Merge, Bulk delete, Import, Export and Permanently
-- delete on their own, because every one of them is either irreversible or a
-- lever on the whole database rather than on one record. Holding a hub at edit
-- says somebody may work in it; it does not say they may empty it.
--
-- Stored the way view_hubs and edit_hubs already are: an enum array on the
-- membership, and the same array on the invitation so a seat arrives holding what
-- it was offered rather than being narrowed after somebody remembers to.
--
-- Existing seats are backfilled with all six. Every one of them could already do
-- all six, and a permissions migration that silently takes access away is a worse
-- failure than one that grants too much on day one.

CREATE TYPE public.rawr_critical_action AS ENUM (
  'delete', 'merge', 'bulk_delete', 'import', 'export', 'purge'
);
--> statement-breakpoint

ALTER TABLE public.membership
  ADD COLUMN IF NOT EXISTS critical_grants public.rawr_critical_action[] NOT NULL DEFAULT '{}';
--> statement-breakpoint

ALTER TABLE public.invitation
  ADD COLUMN IF NOT EXISTS critical_grants public.rawr_critical_action[] NOT NULL DEFAULT '{}';
--> statement-breakpoint

UPDATE public.membership
   SET critical_grants = ARRAY['delete', 'merge', 'bulk_delete', 'import', 'export', 'purge']::public.rawr_critical_action[]
 WHERE critical_grants = '{}';
--> statement-breakpoint

-- The session reads its grants here, so the column has to come back with them or
-- every request lands holding nothing.
DROP FUNCTION IF EXISTS rawr.memberships_for_user(uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rawr.memberships_for_user(p_user_id uuid)
 RETURNS TABLE(account_id uuid, account_slug text, account_name text, hosted_domain text,
               user_id uuid, email text, display_name text, avatar_url text,
               is_super_admin boolean, view_hubs public.rawr_hub[], edit_hubs public.rawr_hub[],
               critical_grants public.rawr_critical_action[],
               joined_at timestamptz, sessions_valid_after timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT a.id, a.slug, a.name, a.google_hosted_domain,
           u.id, u.email, u.name, u.avatar_url,
           m.is_super_admin, m.view_hubs, m.edit_hubs, m.critical_grants,
           m.created_at, u.sessions_valid_after
      FROM public.user_account u
      JOIN public.membership m ON m.user_id = u.id AND m.state = 'active'
      JOIN public.account a ON a.id = m.account_id
     WHERE u.id = p_user_id
     ORDER BY a.name
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.memberships_for_user(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.memberships_for_user(uuid) TO rawr_app;
--> statement-breakpoint

-- An agent token can only ever reach what its holder reaches, which now includes
-- what its holder may not do.
DROP FUNCTION IF EXISTS rawr.mcp_token_owner(text);
--> statement-breakpoint

CREATE FUNCTION rawr.mcp_token_owner(p_hash text)
 RETURNS TABLE(token_id uuid, account_id uuid, account_slug text, account_name text,
               user_id uuid, user_email text, user_name text,
               is_super_admin boolean, view_hubs public.rawr_hub[], edit_hubs public.rawr_hub[],
               critical_grants public.rawr_critical_action[])
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT t.id, t.account_id, a.slug, a.name,
           u.id, u.email, u.name,
           m.is_super_admin, m.view_hubs, m.edit_hubs, m.critical_grants
      FROM public.mcp_token t
      JOIN public.account a ON a.id = t.account_id
      JOIN public.user_account u ON u.id = t.user_id
      JOIN public.membership m
        ON m.account_id = t.account_id AND m.user_id = t.user_id AND m.state = 'active'
     WHERE t.token_hash = p_hash AND t.revoked_at IS NULL
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.mcp_token_owner(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.mcp_token_owner(text) TO rawr_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.accept_invitation(p_token_hash text, p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_invite public.invitation%ROWTYPE;
  v_email text;
BEGIN
  SELECT * INTO v_invite FROM public.invitation
   WHERE token_hash = p_token_hash
     AND accepted_at IS NULL
     AND revoked_at IS NULL
     AND expires_at > now();
  IF v_invite.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT lower(email) INTO v_email FROM public.user_account WHERE id = p_user_id;
  -- The invitation names an address; the person signing in must be that person.
  IF v_email IS DISTINCT FROM lower(v_invite.email) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.membership (account_id, user_id, is_super_admin, view_hubs, edit_hubs,
                                 view_scopes, edit_scopes, critical_grants, state, invited_by)
  VALUES (v_invite.account_id, p_user_id, v_invite.is_super_admin,
          v_invite.view_hubs, v_invite.edit_hubs,
          v_invite.view_scopes, v_invite.edit_scopes, v_invite.critical_grants,
          'active', v_invite.invited_by)
  ON CONFLICT (account_id, user_id) DO UPDATE
    SET state = 'active',
        is_super_admin = public.membership.is_super_admin OR excluded.is_super_admin,
        view_hubs = excluded.view_hubs,
        edit_hubs = excluded.edit_hubs,
        view_scopes = excluded.view_scopes,
        edit_scopes = excluded.edit_scopes,
        critical_grants = excluded.critical_grants;

  UPDATE public.invitation SET accepted_at = now() WHERE id = v_invite.id;
  RETURN v_invite.account_id;
END
$$;
