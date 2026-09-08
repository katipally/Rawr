-- HubSpot's third axis on a permission. A grant already says which hubs a seat
-- may view and edit; this says how much of each hub it reaches: everything in
-- the account, everything owned by its team, or only what it owns itself.
--
-- It is enforced in the row level security policy rather than in the queries,
-- because the queries are not the only reader. The MCP surface, the exporter and
-- the reporting rollups all go straight to the tables, and a scope honoured in
-- one list page and nowhere else is not a permission, it is a decoration.

DO $$ BEGIN
  CREATE TYPE public.rawr_scope AS ENUM ('everything', 'team', 'own');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A hub absent from the map is unscoped, so an existing seat keeps seeing
-- everything it could see before this migration ran.
ALTER TABLE public.membership
  ADD COLUMN IF NOT EXISTS view_scopes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS edit_scopes jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.membership.view_scopes IS
  'hub -> rawr_scope. A hub that is absent reaches everything in the account.';

-- Who the session is acting as. The tenant GUC alone cannot answer an ownership
-- question, and a policy cannot see the application''s context object.
CREATE OR REPLACE FUNCTION rawr.current_actor()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('rawr.user_id', true), '')::uuid
$$;

-- NULL means no restriction, which is deliberately what a session with no actor
-- gets: the worker, an inbound webhook and a public form submission all run
-- without a seat, and none of them is a person whose view should be narrowed.
-- The tenant policy still holds them inside one account.
CREATE OR REPLACE FUNCTION rawr.visible_owners(hub text, writing boolean DEFAULT false)
RETURNS uuid[]
LANGUAGE sql
STABLE
AS $$
  WITH seat AS (
    SELECT m.user_id, m.is_super_admin,
           (CASE WHEN writing THEN m.edit_scopes ELSE m.view_scopes END ->> hub)::public.rawr_scope AS scope
      FROM public.membership m
     WHERE m.account_id = rawr.current_account()
       AND m.user_id = rawr.current_actor()
       AND m.state = 'active'
  )
  SELECT CASE
    WHEN (SELECT is_super_admin FROM seat) THEN NULL
    WHEN (SELECT scope FROM seat) = 'own' THEN ARRAY[(SELECT user_id FROM seat)]
    WHEN (SELECT scope FROM seat) = 'team' THEN COALESCE((
      SELECT array_agg(DISTINCT mine.user_id)
        FROM public.team_member mine
        JOIN public.team_member ours ON ours.team_id = mine.team_id
       WHERE ours.user_id = (SELECT user_id FROM seat)
    ), ARRAY[(SELECT user_id FROM seat)])
    ELSE NULL
  END
$$;

-- Rebuilt so a table that owns records carries the scope predicate as well as
-- the tenant one. Every other table is untouched: an activity, an association
-- and an audit row are reached through a record the scope already gated.
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
    -- Records, not assets. A dashboard, a saved view, a sequence and a booking
    -- page also carry owner_id, but they are shared by their own rules and
    -- scoping them would hide a colleague's shared dashboard.
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
      -- Wrapped in a scalar subquery on purpose. A STABLE function sitting in a
      -- row filter is still called once per row even with constant arguments;
      -- measured, that was 53us a row, which is five seconds over 88k contacts.
      -- A subquery with no outer reference becomes an InitPlan and runs once for
      -- the whole statement. The cast is load bearing: `ANY(<bare subquery>)` is
      -- read as the set form and fails on uuid = uuid[], while a cast expression
      -- is read as the array form.
      --
      -- `= ANY(NULL)` is NULL, and so is the comparison for an unowned row, so
      -- the coalesce covers both cases the same way: an unrestricted seat and an
      -- unassigned record are both visible. In HubSpot an unassigned lead is
      -- what a team picks up, and hiding it would strand it.
      using_expr := using_expr || format(
        ' AND coalesce(owner_id = ANY((SELECT rawr.visible_owners(%L, false))::uuid[]), true)', hub);
      check_expr := check_expr || format(
        ' AND coalesce(owner_id = ANY((SELECT rawr.visible_owners(%L, true))::uuid[]), true)', hub);
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

SELECT rawr.apply_tenancy();

-- The scope predicate reads team_member on every evaluation, and the owner
-- lookup is the hot half of it.
CREATE INDEX IF NOT EXISTS team_member_user_team_idx ON public.team_member (user_id, team_id);

-- An invitation carries the grants the seat will have, so it has to carry their
-- scopes too or every invited person lands unscoped.
ALTER TABLE public.invitation
  ADD COLUMN IF NOT EXISTS view_scopes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS edit_scopes jsonb NOT NULL DEFAULT '{}'::jsonb;

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
                                 view_scopes, edit_scopes, state, invited_by)
  VALUES (v_invite.account_id, p_user_id, v_invite.is_super_admin,
          v_invite.view_hubs, v_invite.edit_hubs,
          v_invite.view_scopes, v_invite.edit_scopes, 'active', v_invite.invited_by)
  ON CONFLICT (account_id, user_id) DO UPDATE
    SET state = 'active',
        is_super_admin = public.membership.is_super_admin OR excluded.is_super_admin,
        view_hubs = excluded.view_hubs,
        edit_hubs = excluded.edit_hubs,
        view_scopes = excluded.view_scopes,
        edit_scopes = excluded.edit_scopes;

  UPDATE public.invitation SET accepted_at = now() WHERE id = v_invite.id;
  RETURN v_invite.account_id;
END
$$;
