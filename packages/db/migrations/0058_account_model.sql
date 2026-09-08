-- The HubSpot account model. The organisation folds into the workspace and what
-- is left is an account: one tenant, named by a portal id in every URL, with
-- nothing above it and nothing below it. Datasaur's own portal runs this way —
-- one account, no teams, no business units — so the layer that used to sit above
-- a workspace had nothing left to hold, and two membership tables, two audit logs
-- and two invitation paths collapse into one of each.
--
-- Roles go with it. HubSpot grants a hub at a time, so `rawr_role` becomes a set
-- of hubs the member may read and a set they may write, with super admin above.

CREATE TYPE public.rawr_hub AS ENUM ('contacts', 'sales', 'marketing', 'service', 'reports', 'account');
--> statement-breakpoint

-- Every policy first: the columns underneath are about to be renamed, and a
-- policy that names a column pins it. rawr.apply_tenancy() rebuilds the tenant
-- policies after this migration, and the three hand-written ones are at the end.
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'
  LOOP EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, p.tablename); END LOOP;
END
$$;
--> statement-breakpoint

-- Every function too. Half of them name a workspace in their signature, and a
-- returns-table signature cannot be replaced in place, only dropped. All of them
-- are recreated below.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'rawr'
  LOOP EXECUTE format('DROP FUNCTION %s', f.sig); END LOOP;
END
$$;
--> statement-breakpoint

-- One account per organisation. An organisation that owned more than one
-- workspace keeps its oldest; the rest go, with the records in them, because the
-- model this migration moves to has no room for a second set.
DELETE FROM public.workspace w
 WHERE w.id <> (
   SELECT x.id FROM public.workspace x
    WHERE x.organisation_id = w.organisation_id
    ORDER BY x.created_at, x.name LIMIT 1);
--> statement-breakpoint

-- invitation carried both an organisation and an optional workspace. It keeps one
-- account, and its two role columns become grants. Done before the generic column
-- rename below, which would otherwise collide on account_id.
ALTER TABLE public.invitation
  DROP COLUMN workspace_id,
  DROP COLUMN workspace_role,
  DROP COLUMN org_role,
  ADD COLUMN is_super_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN view_hubs public.rawr_hub[] NOT NULL DEFAULT '{}',
  ADD COLUMN edit_hubs public.rawr_hub[] NOT NULL DEFAULT '{}';
--> statement-breakpoint

ALTER TABLE public.workspace RENAME TO account;
--> statement-breakpoint

ALTER TABLE public.account
  ADD COLUMN google_hosted_domain text,
  ADD COLUMN auto_join_hosted_domain boolean NOT NULL DEFAULT true,
  ADD COLUMN default_view_hubs public.rawr_hub[] NOT NULL DEFAULT '{}',
  ADD COLUMN seat_limit integer,
  ADD COLUMN activity_retention_months integer NOT NULL DEFAULT 25;
--> statement-breakpoint

UPDATE public.account a SET
  google_hosted_domain = o.google_hosted_domain,
  auto_join_hosted_domain = o.auto_join_hosted_domain,
  seat_limit = o.seat_limit,
  activity_retention_months = o.activity_retention_months
FROM public.organisation o WHERE o.id = a.organisation_id;
--> statement-breakpoint

-- A domain joiner used to land as a viewer on every workspace. The same arrival
-- now reads the four hubs a viewer could see and writes none of them.
UPDATE public.account SET default_view_hubs =
  ARRAY['contacts', 'sales', 'marketing', 'reports']::public.rawr_hub[]
 WHERE auto_join_hosted_domain;
--> statement-breakpoint

ALTER TABLE public.account
  ALTER COLUMN google_hosted_domain SET NOT NULL,
  ADD CONSTRAINT account_google_hosted_domain_unique UNIQUE (google_hosted_domain);
--> statement-breakpoint

-- integration and invitation hung off the organisation. They hang off the account
-- now, which makes both ordinary tenant tables with an ordinary tenant policy.
-- The old keys go first, or the backfill below is checked against a table whose
-- ids it is deliberately no longer using.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conrelid::regclass AS tbl, con.conname
      FROM pg_constraint con
     WHERE con.contype = 'f' AND con.confrelid = 'public.organisation'::regclass
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname); END LOOP;
END
$$;
--> statement-breakpoint

ALTER TABLE public.integration RENAME COLUMN organisation_id TO account_id;
--> statement-breakpoint
ALTER TABLE public.invitation RENAME COLUMN organisation_id TO account_id;
--> statement-breakpoint

UPDATE public.integration i SET account_id = a.id FROM public.account a WHERE a.organisation_id = i.account_id;
--> statement-breakpoint
UPDATE public.invitation v SET account_id = a.id FROM public.account a WHERE a.organisation_id = v.account_id;
--> statement-breakpoint

-- Anything pointing at an organisation that no longer maps to an account.
DELETE FROM public.integration WHERE account_id NOT IN (SELECT id FROM public.account);
--> statement-breakpoint
DELETE FROM public.invitation WHERE account_id NOT IN (SELECT id FROM public.account);
--> statement-breakpoint

ALTER TABLE public.integration
  ADD CONSTRAINT integration_account_id_fk FOREIGN KEY (account_id) REFERENCES public.account(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE public.invitation
  ADD CONSTRAINT invitation_account_id_fk FOREIGN KEY (account_id) REFERENCES public.account(id) ON DELETE CASCADE;
--> statement-breakpoint

-- Every remaining tenant table, found by inspection rather than by a list somebody
-- has to keep in step.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
                         AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP EXECUTE format('ALTER TABLE public.%I RENAME COLUMN workspace_id TO account_id', t.relname); END LOOP;
END
$$;
--> statement-breakpoint

-- The four roles become the grants they always stood for.
ALTER TABLE public.membership
  ADD COLUMN is_super_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN view_hubs public.rawr_hub[] NOT NULL DEFAULT '{}',
  ADD COLUMN edit_hubs public.rawr_hub[] NOT NULL DEFAULT '{}',
  ADD COLUMN state public.rawr_member_state NOT NULL DEFAULT 'active',
  ADD COLUMN invited_by uuid REFERENCES public.user_account(id) ON DELETE SET NULL,
  ADD COLUMN deactivated_at timestamptz,
  ADD COLUMN deactivated_by uuid REFERENCES public.user_account(id) ON DELETE SET NULL;
--> statement-breakpoint

UPDATE public.membership SET
  edit_hubs = CASE role
    WHEN 'admin'     THEN ARRAY['contacts','sales','marketing','service','reports','account']
    WHEN 'sales'     THEN ARRAY['contacts','sales']
    WHEN 'marketing' THEN ARRAY['contacts','marketing']
    ELSE ARRAY[]::text[] END::public.rawr_hub[],
  view_hubs = CASE role
    WHEN 'viewer' THEN ARRAY['contacts','sales','marketing','reports']
    ELSE ARRAY['reports'] END::public.rawr_hub[];
--> statement-breakpoint

-- Being in the organisation was what made a session answer at all, so its state
-- and its history come across with it, and org_admin becomes super admin.
UPDATE public.membership m SET
  is_super_admin = (om.role = 'org_admin'),
  state = om.state,
  invited_by = om.invited_by,
  deactivated_at = om.deactivated_at,
  deactivated_by = om.deactivated_by
FROM public.organisation_membership om WHERE om.user_id = m.user_id;
--> statement-breakpoint

ALTER TABLE public.membership DROP COLUMN role;
--> statement-breakpoint

-- With one tenant there is no act that belongs to no account, so the second audit
-- log has nowhere separate to live.
INSERT INTO public.audit_log (account_id, actor_id, actor_kind, entity, entity_id, action, before, after, at)
SELECT a.id, l.actor_id, l.actor_kind, l.entity, l.entity_id, l.action, l.before, l.after, l.at
  FROM public.organisation_audit_log l JOIN public.account a ON a.organisation_id = l.organisation_id;
--> statement-breakpoint

DROP TABLE public.organisation_audit_log;
--> statement-breakpoint
DROP TABLE public.organisation_membership;
--> statement-breakpoint
ALTER TABLE public.account DROP COLUMN organisation_id;
--> statement-breakpoint
DROP TABLE public.organisation;
--> statement-breakpoint
DROP TYPE public.rawr_role;
--> statement-breakpoint
DROP TYPE public.rawr_org_role;
--> statement-breakpoint

DO $$
DECLARE i record;
BEGIN
  FOR i IN SELECT indexname FROM pg_indexes
            WHERE schemaname = 'public' AND (indexname LIKE '%workspace%' OR indexname LIKE '%organisation%' OR indexname LIKE '%\_org\_%')
  LOOP
    EXECUTE format('ALTER INDEX public.%I RENAME TO %I', i.indexname,
      replace(replace(replace(i.indexname, 'workspace', 'account'), 'organisation', 'account'), '_org_', '_account_'));
  END LOOP;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.current_account() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('rawr.account_id', true), '')::uuid
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.apply_tenancy() RETURNS int
  LANGUAGE plpgsql AS $fn$
DECLARE
  t record;
  applied int := 0;
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
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS rawr_tenant ON public.%I', t.relname);
    EXECUTE format(
      'CREATE POLICY rawr_tenant ON public.%I USING (account_id = rawr.current_account())'
      || ' WITH CHECK (account_id = rawr.current_account())', t.relname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO rawr_app', t.relname);
    applied := applied + 1;
  END LOOP;

  -- Append only. History cannot be rewritten even with a valid session.
  REVOKE UPDATE, DELETE ON public.audit_log FROM rawr_app;

  RETURN applied;
END
$fn$;
--> statement-breakpoint

-- account and user_account carry no account_id, so they need policies written by
-- hand. Both are still FORCE RLS and still invisible without a scope set.
ALTER TABLE public.account ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.account FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY rawr_self ON public.account USING (id = rawr.current_account());
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.account TO rawr_app;
--> statement-breakpoint

ALTER TABLE public.user_account ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.user_account FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY rawr_member ON public.user_account USING (
  EXISTS (SELECT 1 FROM public.membership m
           WHERE m.user_id = user_account.id AND m.account_id = rawr.current_account()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.user_account TO rawr_app;
--> statement-breakpoint

-- A client is a public name and a redirect address, registered before anybody has
-- signed in, so it belongs to no account and is readable by all of them.
ALTER TABLE public.mcp_client ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mcp_client FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY rawr_global ON public.mcp_client USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mcp_client TO rawr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rawr.booking_for_token(p_purpose text, p_token text)
 RETURNS TABLE(account_id uuid, booking_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT b.account_id, b.id
      FROM public.booking b
     WHERE (p_purpose = 'cancel' AND b.cancel_token = p_token)
        OR (p_purpose = 'reschedule' AND b.reschedule_token = p_token)
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.booking_hold_account(p_token text)
 RETURNS TABLE(account_id uuid, booking_page_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT h.account_id, h.booking_page_id FROM public.booking_hold h WHERE h.token = p_token
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.mcp_code_redeem(p_hash text)
 RETURNS TABLE(account_id uuid, user_id uuid, client_id text, code_challenge text, redirect_uri text, resource text, scope text, expires_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    DELETE FROM public.mcp_oauth_code c
     WHERE c.code_hash = p_hash
    RETURNING c.account_id, c.user_id, c.client_id, c.code_challenge, c.redirect_uri,
              c.resource, c.scope, c.expires_at
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.mcp_refresh_owner(p_hash text)
 RETURNS TABLE(token_id uuid, account_id uuid, user_id uuid, client_id text, scope text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT t.id, t.account_id, t.user_id, t.client_id, t.scope
      FROM public.mcp_token t
      JOIN public.membership m ON m.account_id = t.account_id AND m.user_id = t.user_id
     WHERE t.refresh_hash = p_hash AND t.revoked_at IS NULL
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.mcp_token_owner(p_hash text)
 RETURNS TABLE(token_id uuid, account_id uuid, account_slug text, account_name text, user_id uuid, user_email text, user_name text, is_super_admin boolean, view_hubs rawr_hub[], edit_hubs rawr_hub[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT t.id, t.account_id, a.slug, a.name,
           u.id, u.email, u.name,
           m.is_super_admin, m.view_hubs, m.edit_hubs
      FROM public.mcp_token t
      JOIN public.account a ON a.id = t.account_id
      JOIN public.user_account u ON u.id = t.user_id
      JOIN public.membership m
        ON m.account_id = t.account_id AND m.user_id = t.user_id AND m.state = 'active'
     WHERE t.token_hash = p_hash AND t.revoked_at IS NULL
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.mcp_token_used(p_token_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    UPDATE public.mcp_token SET last_used_at = now() WHERE id = p_token_id
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.public_booking_page(p_account_slug text, p_slug text)
 RETURNS TABLE(account_id uuid, account_slug text, account_name text, booking_page_id uuid, slug text, name text, kind rawr_booking_kind, duration_minutes integer, buffer_before_minutes integer, buffer_after_minutes integer, min_notice_minutes integer, max_horizon_days integer, granularity_minutes integer, location rawr_booking_location, location_detail text, questions jsonb, is_active boolean, redirect_url text, confirmation_copy text, host_names text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT p.account_id, w.slug, w.name, p.id, p.slug, p.name, p.kind,
           p.duration_minutes, p.buffer_before_minutes, p.buffer_after_minutes,
           p.min_notice_minutes, p.max_horizon_days, p.granularity_minutes,
           p.location, p.location_detail, p.questions, p.is_active,
           p.redirect_url, p.confirmation_copy,
           coalesce(
             (SELECT array_agg(u.name ORDER BY u.name)
                FROM public.booking_host h
                JOIN public.user_account u ON u.id = h.user_id
               WHERE h.booking_page_id = p.id AND h.is_active),
             '{}'::text[]
           )
      FROM public.booking_page p
      JOIN public.account w ON w.id = p.account_id
     WHERE w.slug = p_account_slug AND p.slug = p_slug
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.public_form(p_form_id uuid)
 RETURNS TABLE(account_id uuid, account_slug text, form_id uuid, name text, slug text, schema jsonb, settings jsonb, is_active boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT f.account_id, w.slug, f.id, f.name, f.slug, f.schema, f.settings, f.is_active
      FROM public.form f
      JOIN public.account w ON w.id = f.account_id
     WHERE f.id = p_form_id
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.public_form_by_slug(p_account_slug text, p_slug text)
 RETURNS TABLE(account_id uuid, account_slug text, form_id uuid, name text, slug text, schema jsonb, settings jsonb, is_active boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT f.account_id, w.slug, f.id, f.name, f.slug, f.schema, f.settings, f.is_active
      FROM public.form f
      JOIN public.account w ON w.id = f.account_id
     WHERE w.slug = p_account_slug AND f.slug = p_slug
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.public_site(p_site_key text)
 RETURNS TABLE(account_id uuid, site_id uuid, host text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT s.account_id, s.id, s.host
      FROM public.site s
     WHERE s.site_key = p_site_key AND s.is_active
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.record_integration_health(p_kind text, p_ok boolean, p_error text, p_disconnected boolean)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE public.integration i
     SET last_ok_at    = CASE WHEN p_ok THEN now() ELSE i.last_ok_at END,
         last_error    = CASE WHEN p_ok THEN NULL ELSE left(p_error, 2000) END,
         last_error_at = CASE WHEN p_ok THEN NULL ELSE now() END,
         state         = CASE WHEN p_ok THEN 'connected'
                              WHEN p_disconnected THEN 'revoked'
                              ELSE 'degraded' END::public.rawr_integration_state
   WHERE i.kind = p_kind
     AND i.account_id = rawr.current_account()
  $function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.set_tracking_domain(p_domain text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ws uuid := rawr.current_account();
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'no account is set on this transaction';
  END IF;
  UPDATE public.account SET tracking_domain = nullif(btrim(p_domain), '') WHERE id = v_ws;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.sign_out_everywhere(p_user_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    UPDATE public.user_account SET sessions_valid_after = now() WHERE id = p_user_id
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.user_id_for_email(p_email text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT id FROM public.user_account WHERE lower(email) = lower(p_email) LIMIT 1
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.account_for_link_token(p_token text)
 RETURNS TABLE(id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT l.account_id FROM public.sequence_link l WHERE l.token = p_token LIMIT 1
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.account_for_send_token(p_token text)
 RETURNS TABLE(id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT d.account_id FROM public.sequence_send d WHERE d.token = p_token LIMIT 1
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.account_for_site(p_site_key text)
 RETURNS TABLE(id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT s.account_id FROM public.site s
      WHERE s.site_key = p_site_key AND s.is_active
    UNION ALL
    SELECT w.id FROM public.account w
      WHERE w.slug = p_site_key
        AND NOT EXISTS (SELECT 1 FROM public.site s2 WHERE s2.site_key = p_site_key)
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.account_for_unsubscribe_token(p_token text)
 RETURNS TABLE(id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT e.account_id FROM public.sequence_enrollment e WHERE e.unsubscribe_token = p_token LIMIT 1
$function$;
--> statement-breakpoint-- Everything a session needs about one person, in one row per account they are in.
-- The organisation join is gone, so being active is now a fact about the
-- membership itself.
CREATE OR REPLACE FUNCTION rawr.memberships_for_user(p_user_id uuid)
 RETURNS TABLE(account_id uuid, account_slug text, account_name text, hosted_domain text,
               user_id uuid, email text, display_name text, avatar_url text,
               is_super_admin boolean, view_hubs public.rawr_hub[], edit_hubs public.rawr_hub[],
               joined_at timestamptz, sessions_valid_after timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT a.id, a.slug, a.name, a.google_hosted_domain,
           u.id, u.email, u.name, u.avatar_url,
           m.is_super_admin, m.view_hubs, m.edit_hubs,
           m.created_at, u.sessions_valid_after
      FROM public.user_account u
      JOIN public.membership m ON m.user_id = u.id AND m.state = 'active'
      JOIN public.account a ON a.id = m.account_id
     WHERE u.id = p_user_id
     ORDER BY a.name
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.add_member(
  p_email text, p_name text, p_view_hubs public.rawr_hub[], p_edit_hubs public.rawr_hub[])
 RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_account uuid := rawr.current_account();
  v_user uuid;
BEGIN
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'no account is set on this transaction';
  END IF;

  SELECT id INTO v_user FROM public.user_account WHERE lower(email) = lower(p_email);
  IF v_user IS NULL THEN
    INSERT INTO public.user_account (email, name)
    VALUES (lower(p_email), coalesce(nullif(p_name, ''), p_email))
    RETURNING id INTO v_user;
  END IF;

  INSERT INTO public.membership (account_id, user_id, view_hubs, edit_hubs, state)
  VALUES (v_account, v_user, coalesce(p_view_hubs, '{}'), coalesce(p_edit_hubs, '{}'), 'active')
  ON CONFLICT (account_id, user_id) DO UPDATE
    SET state = CASE WHEN public.membership.state = 'invited' THEN 'active'
                     ELSE public.membership.state END;

  RETURN v_user;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.invitation_offer(p_token_hash text)
 RETURNS TABLE(email text, account_name text, expired boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT i.email, a.name, (i.expires_at <= now())
      FROM public.invitation i
      JOIN public.account a ON a.id = i.account_id
     WHERE i.token_hash = p_token_hash
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
     LIMIT 1
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.accept_invitation(p_token_hash text, p_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
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

  INSERT INTO public.membership (account_id, user_id, is_super_admin, view_hubs, edit_hubs, state, invited_by)
  VALUES (v_invite.account_id, p_user_id, v_invite.is_super_admin,
          v_invite.view_hubs, v_invite.edit_hubs, 'active', v_invite.invited_by)
  ON CONFLICT (account_id, user_id) DO UPDATE
    SET state = 'active',
        is_super_admin = public.membership.is_super_admin OR excluded.is_super_admin,
        view_hubs = excluded.view_hubs,
        edit_hubs = excluded.edit_hubs;

  UPDATE public.invitation SET accepted_at = now() WHERE id = v_invite.id;
  RETURN v_invite.account_id;
END
$function$;
--> statement-breakpoint

-- Signing in, and the only way a first account comes into being. An address on a
-- domain no account claims creates one and takes it as super admin, which is how
-- signing up for HubSpot works and what makes this app startable from an empty
-- database. A domain somebody already claimed joins it instead, on the terms that
-- account set, and a personal address joins nothing until it is invited.
CREATE OR REPLACE FUNCTION rawr.sign_in_google(
  p_sub text, p_email text, p_name text, p_picture text, p_hosted_domain text)
 RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user uuid;
  v_account uuid;
  v_auto boolean;
  v_hubs public.rawr_hub[];
  v_slug text;
BEGIN
  SELECT id INTO v_user FROM public.user_account WHERE google_sub = p_sub;

  IF v_user IS NULL THEN
    -- A pre-provisioned or seeded account is claimed by its email on first sign-in.
    SELECT id INTO v_user FROM public.user_account
     WHERE lower(email) = lower(p_email) AND (google_sub IS NULL OR google_sub LIKE 'dev:%');
  END IF;

  IF v_user IS NULL THEN
    INSERT INTO public.user_account (email, google_sub, name, avatar_url)
    VALUES (lower(p_email), p_sub, coalesce(nullif(p_name, ''), p_email), p_picture)
    RETURNING id INTO v_user;
  ELSE
    UPDATE public.user_account
       SET google_sub = p_sub,
           name = coalesce(nullif(p_name, ''), name),
           avatar_url = coalesce(p_picture, avatar_url)
     WHERE id = v_user;
  END IF;

  IF p_hosted_domain = '' OR p_hosted_domain IS NULL THEN
    RETURN v_user;
  END IF;

  SELECT id, auto_join_hosted_domain, default_view_hubs INTO v_account, v_auto, v_hubs
    FROM public.account WHERE google_hosted_domain = p_hosted_domain;

  IF v_account IS NULL THEN
    -- The slug is what every URL carries, so it has to be a bare label and it has
    -- to be free. The domain's first label, then -2, -3 until one is.
    v_slug := regexp_replace(lower(split_part(p_hosted_domain, '.', 1)), '[^a-z0-9-]', '-', 'g');
    IF EXISTS (SELECT 1 FROM public.account WHERE slug = v_slug) THEN
      SELECT v_slug || '-' || n FROM generate_series(2, 999) n
       WHERE NOT EXISTS (SELECT 1 FROM public.account a WHERE a.slug = v_slug || '-' || n)
       LIMIT 1 INTO v_slug;
    END IF;

    INSERT INTO public.account (name, slug, google_hosted_domain, default_view_hubs)
    VALUES (initcap(split_part(p_hosted_domain, '.', 1)), v_slug, p_hosted_domain,
            ARRAY['contacts','sales','marketing','reports']::public.rawr_hub[])
    RETURNING id INTO v_account;

    -- Whoever opens the account owns it. Without this there is no way to grant
    -- anybody anything, and the account is unreachable the moment it exists.
    INSERT INTO public.membership (account_id, user_id, is_super_admin, edit_hubs, state)
    VALUES (v_account, v_user, true,
            ARRAY['contacts','sales','marketing','service','reports','account']::public.rawr_hub[],
            'active');

    RETURN v_user;
  END IF;

  IF v_auto THEN
    INSERT INTO public.membership (account_id, user_id, view_hubs, state)
    VALUES (v_account, v_user, v_hubs, 'active')
    -- An invited seat becomes active on the sign-in that claims it; a deactivated
    -- one stays deactivated, or ending somebody's access would not hold.
    ON CONFLICT (account_id, user_id) DO UPDATE
      SET state = CASE WHEN public.membership.state = 'invited' THEN 'active'
                       ELSE public.membership.state END;
  END IF;

  RETURN v_user;
END
$function$;
--> statement-breakpoint

-- The account a new sign-in provisions still needs its objects, fields, views,
-- pipelines and stages. That is application code, not SQL, so the callback calls
-- provisionAccount after this returns; this function reports whether it has to.
CREATE OR REPLACE FUNCTION rawr.account_needs_provisioning(p_account_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT NOT EXISTS (SELECT 1 FROM public.object_def WHERE account_id = p_account_id)
$function$;
--> statement-breakpoint
