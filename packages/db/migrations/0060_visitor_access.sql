-- Sign-in becomes the only way in, and it seats everybody.
--
-- Three cases, settled here rather than in the callback, so the agent surface and
-- any future caller get the same answer as the browser does:
--
--   an empty database    the signer opens the account and owns it
--   a claimed domain     they join it, as before
--   anybody else         a read-only seat in the visitor account, if one is named
--
-- The visitor account is named by the caller (RAWR_VISITOR_ACCOUNT) rather than
-- read from a table: the function stays a pure function of its arguments, and a
-- deployment that names nothing seats nobody, which is the safe direction.

-- An account that claims no domain. `google_hosted_domain` is NOT NULL UNIQUE, so
-- the empty string is the one way to say "claims nothing" and the constraint
-- allows exactly one such account -- which is the same "once, ever" the bootstrap
-- branch below already guarantees.
CREATE OR REPLACE FUNCTION rawr.sign_in_google(
  p_sub text, p_email text, p_name text, p_picture text, p_hosted_domain text,
  p_visitor_account text)
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

  -- Nothing exists yet, so whoever arrives first owns what they create. Self
  -- closing: the moment this runs there is an account, and the branch is dead for
  -- the life of the database. It takes the visitor account's own slug, so the
  -- account it opens is the one later arrivals are seated into.
  IF NOT EXISTS (SELECT 1 FROM public.account) THEN
    v_slug := coalesce(nullif(p_visitor_account, ''), 'rawr');
    INSERT INTO public.account (name, slug, google_hosted_domain, default_view_hubs)
    VALUES (initcap(replace(v_slug, '-', ' ')), v_slug,
            coalesce(nullif(p_hosted_domain, ''), ''),
            ARRAY['contacts','sales','marketing','reports']::public.rawr_hub[])
    RETURNING id INTO v_account;

    INSERT INTO public.membership (account_id, user_id, is_super_admin, edit_hubs, state)
    VALUES (v_account, v_user, true,
            ARRAY['contacts','sales','marketing','service','reports','account']::public.rawr_hub[],
            'active');

    RETURN v_user;
  END IF;

  IF p_hosted_domain <> '' AND p_hosted_domain IS NOT NULL THEN
    SELECT id, auto_join_hosted_domain, default_view_hubs INTO v_account, v_auto, v_hubs
      FROM public.account WHERE google_hosted_domain = p_hosted_domain;

    IF v_account IS NULL THEN
      -- The slug is what every URL carries, so it has to be a bare label and it
      -- has to be free. The domain's first label, then -2, -3 until one is.
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
      -- An invited seat becomes active on the sign-in that claims it; a
      -- deactivated one stays deactivated, or ending somebody's access would not
      -- hold.
      ON CONFLICT (account_id, user_id) DO UPDATE
        SET state = CASE WHEN public.membership.state = 'invited' THEN 'active'
                         ELSE public.membership.state END;
      RETURN v_user;
    END IF;
  END IF;

  -- Nobody's domain, nobody's invitation. A named visitor account seats them to
  -- read; without one they land on the sign-in page's "no seat yet" message, which
  -- is what a deployment that never set the variable should do.
  IF p_visitor_account <> '' AND p_visitor_account IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.membership WHERE user_id = v_user) THEN
    -- Every hub except `account`: a visitor reads the CRM, not the settings that
    -- seat people and hold the credentials.
    INSERT INTO public.membership (account_id, user_id, view_hubs, state)
    SELECT a.id, v_user,
           ARRAY['contacts','sales','marketing','service','reports']::public.rawr_hub[],
           'active'
      FROM public.account a WHERE a.slug = p_visitor_account
    ON CONFLICT (account_id, user_id) DO NOTHING;
  END IF;

  RETURN v_user;
END
$function$;
--> statement-breakpoint

-- The development sign-in is gone, and this existed only to serve it: it turns an
-- address into a user id with no proof that the caller is that person, which is a
-- password-less sign-in for anybody who can reach the function.
DROP FUNCTION IF EXISTS rawr.user_id_for_email(text);
--> statement-breakpoint

-- The five-argument form is what the old callback called. Dropping it means a
-- deploy that rolls the app back without rolling the schema back fails loudly at
-- the call rather than silently seating nobody.
DROP FUNCTION IF EXISTS rawr.sign_in_google(text, text, text, text, text);
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.sign_in_google(text, text, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.sign_in_google(text, text, text, text, text, text) TO rawr_app;
