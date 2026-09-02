-- Sign-in and membership, done in the database so the app role never needs a
-- cross-tenant grant on user_account or membership.
--
-- A session is keyed by user id from here on, so a person keeps their session
-- across a Google re-link and across a workspace switch.

CREATE OR REPLACE FUNCTION rawr.memberships_for_user(p_user_id uuid)
  RETURNS TABLE (
    workspace_id uuid,
    workspace_slug text,
    workspace_name text,
    hosted_domain text,
    user_id uuid,
    email text,
    display_name text,
    avatar_url text,
    role public.rawr_role
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT w.id, w.slug, w.name, w.google_hosted_domain,
           u.id, u.email, u.name, u.avatar_url, m.role
      FROM public.user_account u
      JOIN public.membership m ON m.user_id = u.id
      JOIN public.workspace w ON w.id = m.workspace_id
     WHERE u.id = p_user_id
     ORDER BY w.name
$$;
REVOKE ALL ON FUNCTION rawr.memberships_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.memberships_for_user(uuid) TO rawr_app;
--> statement-breakpoint

-- Development sign-in only. The app refuses to call it outside development; the
-- function itself is harmless because it returns an id and nothing else.
CREATE OR REPLACE FUNCTION rawr.user_id_for_email(p_email text)
  RETURNS uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT id FROM public.user_account WHERE lower(email) = lower(p_email) LIMIT 1
$$;
REVOKE ALL ON FUNCTION rawr.user_id_for_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.user_id_for_email(text) TO rawr_app;
--> statement-breakpoint

-- A verified Google identity becomes, or is linked to, one user_account, and joins
-- every workspace whose hosted domain matches the id token's hd claim as a viewer.
-- The app checks the hd claim before calling this; the function checks it again
-- by only ever joining on an exact domain match. An admin raises the role later.
CREATE OR REPLACE FUNCTION rawr.sign_in_google(
  p_sub text, p_email text, p_name text, p_picture text, p_hosted_domain text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid;
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

  INSERT INTO public.membership (workspace_id, user_id, role)
  SELECT w.id, v_user, 'viewer'
    FROM public.workspace w
   WHERE p_hosted_domain <> '' AND w.google_hosted_domain = p_hosted_domain
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  RETURN v_user;
END
$$;
REVOKE ALL ON FUNCTION rawr.sign_in_google(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.sign_in_google(text, text, text, text, text) TO rawr_app;
--> statement-breakpoint

-- Adding a member by email before they have ever signed in. Scoped to the
-- workspace pinned on the transaction, so an admin of one tenant cannot seat
-- somebody in another.
CREATE OR REPLACE FUNCTION rawr.add_member(p_email text, p_name text, p_role public.rawr_role)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ws uuid := rawr.current_workspace();
  v_user uuid;
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'no workspace is set on this transaction';
  END IF;

  SELECT id INTO v_user FROM public.user_account WHERE lower(email) = lower(p_email);
  IF v_user IS NULL THEN
    INSERT INTO public.user_account (email, name)
    VALUES (lower(p_email), coalesce(nullif(p_name, ''), p_email))
    RETURNING id INTO v_user;
  END IF;

  INSERT INTO public.membership (workspace_id, user_id, role)
  VALUES (v_ws, v_user, p_role)
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  RETURN v_user;
END
$$;
REVOKE ALL ON FUNCTION rawr.add_member(text, text, public.rawr_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.add_member(text, text, public.rawr_role) TO rawr_app;
--> statement-breakpoint

DROP FUNCTION IF EXISTS rawr.memberships_for_google_sub(text);
