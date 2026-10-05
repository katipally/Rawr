-- Ending somebody's access moved `user_account.sessions_valid_after`, which is the
-- person's and not the account's: a person seated in two accounts was signed out
-- of both when one of them ended their seat. The watermark for an ended seat now
-- sits on the seat. Signing out everywhere is still the person's own, and a
-- session is dead if either watermark passed it.
ALTER TABLE public.membership ADD COLUMN IF NOT EXISTS sessions_valid_after timestamptz;
--> statement-breakpoint

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
           m.created_at, greatest(u.sessions_valid_after, m.sessions_valid_after), a.timezone
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
