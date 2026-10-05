-- Every report, calendar and "today" bucketed days in UTC, because the account had
-- no zone of its own: a form filled at 9:21 PM Pacific on the 1st was charted on
-- the 2nd, and "overdue" flipped at 4 or 5 PM for anybody west of Greenwich.
--
-- One zone per account rather than per person, so two people reading the same
-- report read the same numbers. UTC until somebody says otherwise, which is what
-- every existing account was already getting.
--
-- The name is checked here and not only in the app: every query that buckets a
-- day passes it to AT TIME ZONE, and one that Postgres does not know fails the
-- whole report rather than that one value.

ALTER TABLE public.account ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
--> statement-breakpoint

-- Stores the name as pg_timezone_names spells it, so "america/los_angeles" does
-- not sit beside "America/Los_Angeles" and compare unequal. Abbreviations such as
-- PST are not names there, which is the point: they are a fixed offset and would
-- be wrong for half the year.
CREATE OR REPLACE FUNCTION rawr.assert_known_timezone() RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_name text;
BEGIN
  SELECT name INTO v_name FROM pg_timezone_names WHERE lower(name) = lower(NEW.timezone) LIMIT 1;
  IF v_name IS NULL THEN
    RAISE EXCEPTION '"%" is not a timezone this database recognises.', NEW.timezone
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  NEW.timezone := v_name;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS account_timezone_known ON public.account;
--> statement-breakpoint
CREATE TRIGGER account_timezone_known
  BEFORE INSERT OR UPDATE OF timezone ON public.account
  FOR EACH ROW EXECUTE FUNCTION rawr.assert_known_timezone();
--> statement-breakpoint

-- The session reads the zone with the rest of the membership, so it costs nothing
-- extra per request.
DROP FUNCTION IF EXISTS rawr.memberships_for_user(uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rawr.memberships_for_user(p_user_id uuid)
 RETURNS TABLE(account_id uuid, account_slug text, account_name text, hosted_domain text,
               user_id uuid, email text, display_name text, avatar_url text,
               is_super_admin boolean, view_hubs public.rawr_hub[], edit_hubs public.rawr_hub[],
               critical_grants public.rawr_critical_action[],
               joined_at timestamptz, sessions_valid_after timestamptz, account_timezone text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT a.id, a.slug, a.name, a.google_hosted_domain,
           u.id, u.email, u.name, u.avatar_url,
           m.is_super_admin, m.view_hubs, m.edit_hubs, m.critical_grants,
           m.created_at, u.sessions_valid_after, a.timezone
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
