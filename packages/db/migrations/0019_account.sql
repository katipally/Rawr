-- Account management. Two things a person owns about themselves:
--
--   1. "Sign out everywhere." A session is a signed cookie, so revoking it needs a
--      watermark: any token issued before sessions_valid_after is refused on its
--      next read. The read path already re-checks membership per request, so the
--      watermark rides along on the same call rather than adding one.
--   2. That watermark reaches the app through memberships_for_user, whose return
--      type changes, and a function's row type cannot be altered in place.

ALTER TABLE public.user_account
  ADD COLUMN IF NOT EXISTS sessions_valid_after timestamptz;
--> statement-breakpoint

DROP FUNCTION IF EXISTS rawr.memberships_for_user(uuid);
--> statement-breakpoint
CREATE FUNCTION rawr.memberships_for_user(p_user_id uuid)
  RETURNS TABLE (
    workspace_id uuid,
    workspace_slug text,
    workspace_name text,
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
    SELECT w.id, w.slug, w.name, w.google_hosted_domain,
           u.id, u.email, u.name, u.avatar_url, m.role, m.created_at, u.sessions_valid_after
      FROM public.user_account u
      JOIN public.membership m ON m.user_id = u.id
      JOIN public.workspace w ON w.id = m.workspace_id
     WHERE u.id = p_user_id
     ORDER BY w.name
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rawr.memberships_for_user(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.memberships_for_user(uuid) TO rawr_app;
--> statement-breakpoint

-- Only the signed-in person, about themselves: the caller passes the id from a
-- session the app has already verified, and the function touches one row.
CREATE OR REPLACE FUNCTION rawr.sign_out_everywhere(p_user_id uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE public.user_account SET sessions_valid_after = now() WHERE id = p_user_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rawr.sign_out_everywhere(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.sign_out_everywhere(uuid) TO rawr_app;
