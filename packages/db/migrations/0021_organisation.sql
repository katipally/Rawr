-- An organisation owns workspaces. Until now a workspace was the top of the tree
-- and carried the Google hosted domain itself, which meant two workspaces for the
-- same company each claimed the domain and nobody owned the people.
--
-- Order matters here: the tables arrive, every existing workspace is adopted by an
-- organisation built from its own domain, and only then does the column move.

CREATE TYPE public.rawr_org_role AS ENUM ('org_admin', 'member');
--> statement-breakpoint
CREATE TYPE public.rawr_member_state AS ENUM ('active', 'invited', 'deactivated');
--> statement-breakpoint

CREATE TABLE public.organisation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  google_hosted_domain text NOT NULL UNIQUE,
  auto_join_hosted_domain boolean NOT NULL DEFAULT true,
  seat_limit integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One organisation per distinct domain already in use, named after the first
-- workspace on it, so nothing has to be invented and nothing is lost.
INSERT INTO public.organisation (name, slug, google_hosted_domain)
SELECT DISTINCT ON (w.google_hosted_domain)
       w.name, w.slug, w.google_hosted_domain
  FROM public.workspace w
 ORDER BY w.google_hosted_domain, w.created_at;
--> statement-breakpoint

ALTER TABLE public.workspace ADD COLUMN organisation_id uuid REFERENCES public.organisation(id) ON DELETE CASCADE;
--> statement-breakpoint

UPDATE public.workspace w
   SET organisation_id = o.id
  FROM public.organisation o
 WHERE o.google_hosted_domain = w.google_hosted_domain;
--> statement-breakpoint

ALTER TABLE public.workspace ALTER COLUMN organisation_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE public.workspace DROP COLUMN google_hosted_domain;
--> statement-breakpoint

CREATE TABLE public.organisation_membership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisation(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  role public.rawr_org_role NOT NULL DEFAULT 'member',
  state public.rawr_member_state NOT NULL DEFAULT 'active',
  invited_by uuid REFERENCES public.user_account(id) ON DELETE SET NULL,
  deactivated_at timestamptz,
  deactivated_by uuid REFERENCES public.user_account(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organisation_membership_org_user_key ON public.organisation_membership (organisation_id, user_id);
--> statement-breakpoint

-- Everybody who already holds a workspace membership is in that workspace's
-- organisation, and anybody who is an admin somewhere becomes an org admin: this
-- is the same set of people, described one level up.
INSERT INTO public.organisation_membership (organisation_id, user_id, role, state)
SELECT w.organisation_id, m.user_id,
       CASE WHEN bool_or(m.role = 'admin') THEN 'org_admin' ELSE 'member' END::public.rawr_org_role,
       'active'
  FROM public.membership m
  JOIN public.workspace w ON w.id = m.workspace_id
 GROUP BY w.organisation_id, m.user_id
ON CONFLICT (organisation_id, user_id) DO NOTHING;
--> statement-breakpoint

CREATE TABLE public.invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisation(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES public.workspace(id) ON DELETE CASCADE,
  email text NOT NULL,
  workspace_role public.rawr_role,
  org_role public.rawr_org_role NOT NULL DEFAULT 'member',
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES public.user_account(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitation_org_idx ON public.invitation (organisation_id, created_at DESC);
-- One open invitation per address per organisation: re-inviting resends rather
-- than stacking up links that all still work.
CREATE UNIQUE INDEX invitation_open_key ON public.invitation (organisation_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
--> statement-breakpoint

CREATE TABLE public.organisation_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisation(id) ON DELETE CASCADE,
  actor_id uuid,
  actor_kind public.rawr_actor_kind NOT NULL,
  entity text NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  before jsonb,
  after jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organisation_audit_entity_idx ON public.organisation_audit_log (organisation_id, entity, at DESC);
--> statement-breakpoint

-- Teams are per workspace and carry workspace_id, so apply_tenancy() finds them
-- and gives them row level security without anything written here.
CREATE TABLE public.team (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX team_workspace_name_key ON public.team (workspace_id, name);
--> statement-breakpoint

CREATE TABLE public.team_member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.team(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  is_lead boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX team_member_team_user_key ON public.team_member (team_id, user_id);
--> statement-breakpoint

-- The second scope. Workspace scoping answers "which tenant"; this answers "which
-- company", for the handful of screens that exist above a workspace.
CREATE OR REPLACE FUNCTION rawr.current_organisation() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('rawr.organisation_id', true), '')::uuid
$$;
--> statement-breakpoint

ALTER TABLE public.organisation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organisation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rawr_org ON public.organisation;
CREATE POLICY rawr_org ON public.organisation
  USING (id = rawr.current_organisation())
  WITH CHECK (id = rawr.current_organisation());
GRANT SELECT, UPDATE ON public.organisation TO rawr_app;
--> statement-breakpoint

ALTER TABLE public.organisation_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organisation_membership FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rawr_org ON public.organisation_membership;
CREATE POLICY rawr_org ON public.organisation_membership
  USING (organisation_id = rawr.current_organisation())
  WITH CHECK (organisation_id = rawr.current_organisation());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organisation_membership TO rawr_app;
--> statement-breakpoint

ALTER TABLE public.invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rawr_org ON public.invitation;
CREATE POLICY rawr_org ON public.invitation
  USING (organisation_id = rawr.current_organisation())
  WITH CHECK (organisation_id = rawr.current_organisation());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invitation TO rawr_app;
--> statement-breakpoint

ALTER TABLE public.organisation_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organisation_audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rawr_org ON public.organisation_audit_log;
CREATE POLICY rawr_org ON public.organisation_audit_log
  USING (organisation_id = rawr.current_organisation())
  WITH CHECK (organisation_id = rawr.current_organisation());
GRANT SELECT, INSERT ON public.organisation_audit_log TO rawr_app;
--> statement-breakpoint

-- A workspace is visible to the tenant it is, and to the organisation that owns
-- it, which is what lets the organisation screen list workspaces the person is
-- not a member of. Insert is for creating one from that screen.
DROP POLICY IF EXISTS rawr_self ON public.workspace;
CREATE POLICY rawr_self ON public.workspace
  USING (id = rawr.current_workspace() OR organisation_id = rawr.current_organisation())
  WITH CHECK (organisation_id = rawr.current_organisation());
GRANT INSERT, UPDATE ON public.workspace TO rawr_app;
--> statement-breakpoint

-- A person is visible to a workspace they belong to, as before, and to an
-- organisation they belong to, which is what the members screen lists.
DROP POLICY IF EXISTS rawr_member ON public.user_account;
CREATE POLICY rawr_member ON public.user_account USING (
  EXISTS (
    SELECT 1 FROM public.membership m
     WHERE m.user_id = user_account.id AND m.workspace_id = rawr.current_workspace()
  )
  OR EXISTS (
    SELECT 1 FROM public.organisation_membership om
     WHERE om.user_id = user_account.id AND om.organisation_id = rawr.current_organisation()
  )
);
--> statement-breakpoint

-- History cannot be rewritten here either.
REVOKE UPDATE, DELETE ON public.organisation_audit_log FROM rawr_app;
--> statement-breakpoint

-- Sign-in, one level up. The memberships a person holds now carry their
-- organisation, and a deactivated organisation membership returns none of them,
-- which is what makes deactivation take effect on the next request.
DROP FUNCTION IF EXISTS rawr.memberships_for_user(uuid);
CREATE FUNCTION rawr.memberships_for_user(p_user_id uuid)
  RETURNS TABLE (
    workspace_id uuid,
    workspace_slug text,
    workspace_name text,
    organisation_id uuid,
    organisation_slug text,
    organisation_name text,
    org_role public.rawr_org_role,
    hosted_domain text,
    user_id uuid,
    email text,
    display_name text,
    avatar_url text,
    role public.rawr_role,
    joined_at timestamptz,
    sessions_valid_after timestamptz
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT w.id, w.slug, w.name,
           o.id, o.slug, o.name, om.role,
           o.google_hosted_domain,
           u.id, u.email, u.name, u.avatar_url, m.role,
           m.created_at, u.sessions_valid_after
      FROM public.user_account u
      JOIN public.membership m ON m.user_id = u.id
      JOIN public.workspace w ON w.id = m.workspace_id
      JOIN public.organisation o ON o.id = w.organisation_id
      JOIN public.organisation_membership om
        ON om.organisation_id = o.id AND om.user_id = u.id AND om.state = 'active'
     WHERE u.id = p_user_id
     ORDER BY o.name, w.name
$$;
REVOKE ALL ON FUNCTION rawr.memberships_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.memberships_for_user(uuid) TO rawr_app;
--> statement-breakpoint

-- A verified Google identity joins the organisation that owns its domain. Whether
-- it also lands in that organisation's workspaces is the organisation's own
-- setting: on, everybody who signs in can read; off, a seat is by invitation.
CREATE OR REPLACE FUNCTION rawr.sign_in_google(
  p_sub text, p_email text, p_name text, p_picture text, p_hosted_domain text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid;
  v_org uuid;
  v_auto boolean;
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

  SELECT id, auto_join_hosted_domain INTO v_org, v_auto
    FROM public.organisation
   WHERE p_hosted_domain <> '' AND google_hosted_domain = p_hosted_domain;

  IF v_org IS NOT NULL THEN
    INSERT INTO public.organisation_membership (organisation_id, user_id, role, state)
    VALUES (v_org, v_user, 'member', 'active')
    ON CONFLICT (organisation_id, user_id)
    -- An invited seat becomes active on the sign-in that claims it; a deactivated
    -- one stays deactivated, or ending somebody's access would not hold.
    DO UPDATE SET state = CASE WHEN public.organisation_membership.state = 'invited'
                               THEN 'active' ELSE public.organisation_membership.state END;

    IF v_auto THEN
      INSERT INTO public.membership (workspace_id, user_id, role)
      SELECT w.id, v_user, 'viewer'
        FROM public.workspace w
       WHERE w.organisation_id = v_org
      ON CONFLICT (workspace_id, user_id) DO NOTHING;
    END IF;
  END IF;

  RETURN v_user;
END
$$;
--> statement-breakpoint

-- Accepting an invitation. Security definer because the person accepting has no
-- session yet, and idempotent because a link gets clicked twice.
CREATE OR REPLACE FUNCTION rawr.accept_invitation(p_token_hash text, p_user_id uuid)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_invite public.invitation%ROWTYPE;
  v_email text;
BEGIN
  SELECT * INTO v_invite FROM public.invitation
   WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > now();
  IF v_invite.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT lower(email) INTO v_email FROM public.user_account WHERE id = p_user_id;
  -- The invitation names an address; the person signing in must be that person.
  IF v_email IS DISTINCT FROM lower(v_invite.email) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.organisation_membership (organisation_id, user_id, role, state, invited_by)
  VALUES (v_invite.organisation_id, p_user_id, v_invite.org_role, 'active', v_invite.invited_by)
  ON CONFLICT (organisation_id, user_id) DO UPDATE
    SET state = 'active',
        role = CASE WHEN excluded.role = 'org_admin' THEN 'org_admin'
                    ELSE public.organisation_membership.role END;

  IF v_invite.workspace_id IS NOT NULL AND v_invite.workspace_role IS NOT NULL THEN
    INSERT INTO public.membership (workspace_id, user_id, role)
    VALUES (v_invite.workspace_id, p_user_id, v_invite.workspace_role)
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role;
  END IF;

  UPDATE public.invitation SET accepted_at = coalesce(accepted_at, now()) WHERE id = v_invite.id;
  RETURN v_invite.organisation_id;
END
$$;
REVOKE ALL ON FUNCTION rawr.accept_invitation(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.accept_invitation(text, uuid) TO rawr_app;
--> statement-breakpoint

-- Seating somebody in a workspace also puts them in its organisation, so a member
-- added the old way is not invisible to the organisation screen.
CREATE OR REPLACE FUNCTION rawr.add_member(p_email text, p_name text, p_role public.rawr_role)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ws uuid := rawr.current_workspace();
  v_org uuid;
  v_user uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'no workspace is set on this transaction';
  END IF;

  SELECT organisation_id INTO v_org FROM public.workspace WHERE id = v_ws;

  SELECT id INTO v_user FROM public.user_account WHERE lower(email) = lower(p_email);
  IF v_user IS NULL THEN
    INSERT INTO public.user_account (email, name)
    VALUES (lower(p_email), coalesce(nullif(p_name, ''), p_email))
    RETURNING id INTO v_user;
  END IF;

  INSERT INTO public.organisation_membership (organisation_id, user_id, role, state)
  VALUES (v_org, v_user, 'member', 'active')
  ON CONFLICT (organisation_id, user_id) DO UPDATE
    SET state = CASE WHEN public.organisation_membership.state = 'invited'
                     THEN 'active' ELSE public.organisation_membership.state END;

  INSERT INTO public.membership (workspace_id, user_id, role)
  VALUES (v_ws, v_user, p_role)
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  RETURN v_user;
END
$$;
