-- A session used to be a signed cookie with nothing on the server to point at, so the
-- only way to end one was to end all of them. A sign-in now writes a row, the row is
-- touched when the session is used (at most once every few minutes, so a page view is
-- not a write), and the account settings list those rows and end them one at a time.
--
-- A cookie minted before this release has no row. It is not listed, keeps working until
-- it expires, and is ended by sign out everywhere, which revokes every row too.
--
-- A session belongs to a person, not an account, so there is no account_id and
-- rawr.apply_tenancy() does not touch the table. Row level security is on, forced, and
-- has no policy: the app role reaches the rows only through the security-definer
-- functions below, and each of them takes a person id, so none can read or end another
-- person's session.

CREATE TABLE IF NOT EXISTS public.user_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  device text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
--> statement-breakpoint

COMMENT ON TABLE public.user_session IS
  'One row per sign-in: the browser or device it came from, when it started and was last used, and when it ends or was ended.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS user_session_user_id_idx ON public.user_session (user_id);
--> statement-breakpoint

ALTER TABLE public.user_session ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.user_session FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Refuses every role but the owner, which the functions below run as and which bypasses row level security.
DROP POLICY IF EXISTS rawr_no_direct_access ON public.user_session;
--> statement-breakpoint
CREATE POLICY rawr_no_direct_access ON public.user_session USING (false) WITH CHECK (false);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.open_user_session(p_user_id uuid, p_device text, p_expires_at timestamptz)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    INSERT INTO public.user_session (user_id, device, expires_at)
    VALUES (p_user_id, p_device, p_expires_at)
    RETURNING id
$function$;
--> statement-breakpoint

-- False when the session is ended, expired, or not this person's. Writes last_seen_at
-- only when it is older than p_every.
CREATE OR REPLACE FUNCTION rawr.touch_user_session(p_user_id uuid, p_session_id uuid, p_every interval)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s public.user_session%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.user_session WHERE id = p_session_id AND user_id = p_user_id;
  IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at <= now() THEN
    RETURN false;
  END IF;
  IF s.last_seen_at <= now() - p_every THEN
    UPDATE public.user_session SET last_seen_at = now() WHERE id = p_session_id;
  END IF;
  RETURN true;
END
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.sessions_for_user(p_user_id uuid)
 RETURNS TABLE(id uuid, device text, created_at timestamptz, last_seen_at timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT s.id, s.device, s.created_at, s.last_seen_at
      FROM public.user_session s
     WHERE s.user_id = p_user_id AND s.revoked_at IS NULL AND s.expires_at > now()
     ORDER BY s.last_seen_at DESC
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.revoke_user_session(p_user_id uuid, p_session_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.user_session SET revoked_at = now()
   WHERE id = p_session_id AND user_id = p_user_id AND revoked_at IS NULL;
  RETURN FOUND;
END
$function$;
--> statement-breakpoint

-- Null keeps nothing: every recorded session of the person ends.
CREATE OR REPLACE FUNCTION rawr.revoke_other_user_sessions(p_user_id uuid, p_keep uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    UPDATE public.user_session SET revoked_at = now()
     WHERE user_id = p_user_id AND revoked_at IS NULL AND id IS DISTINCT FROM p_keep
$function$;
--> statement-breakpoint

-- Also ends every recorded session, so the list is empty after it. The watermark stays
-- for the cookies that have no row.
CREATE OR REPLACE FUNCTION rawr.sign_out_everywhere(p_user_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    UPDATE public.user_session SET revoked_at = now() WHERE user_id = p_user_id AND revoked_at IS NULL;
    UPDATE public.user_account SET sessions_valid_after = now() WHERE id = p_user_id
$function$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION rawr.open_user_session(uuid, text, timestamptz) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.touch_user_session(uuid, uuid, interval) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.sessions_for_user(uuid) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.revoke_user_session(uuid, uuid) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.revoke_other_user_sessions(uuid, uuid) TO rawr_app;
