-- Every amount on screen was written in dollars unless the row said otherwise: the
-- deal form offered USD and nothing else, and a report with no deals in the range
-- fell back to "$0". An account that works in another currency had nowhere to say
-- so.
--
-- One currency per account is what a row without its own falls back to; a deal
-- still carries the currency it was made in. USD until somebody says otherwise,
-- which is what every existing account was already getting. A constant default on
-- a small table: no rewrite, no noticeable lock.
ALTER TABLE public.account ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';
--> statement-breakpoint

-- The shape is checked here and the name in the app, which asks the engine's own
-- list: a code the engine cannot format would render as plain text, not break.
ALTER TABLE public.account DROP CONSTRAINT IF EXISTS account_currency_is_iso_shaped;
--> statement-breakpoint
ALTER TABLE public.account ADD CONSTRAINT account_currency_is_iso_shaped CHECK (currency ~ '^[A-Z]{3}$');
--> statement-breakpoint

-- A deal made without a currency took USD from the column default, so changing the
-- account's currency would have changed nothing about the deals made after it. The
-- default moves to the account: a trigger fills the currency a writer left out, and
-- every path that inserts a deal (the form, an import, a bulk action, SQL) gets it
-- without each knowing. A deal that names a currency keeps it.
ALTER TABLE public.deal ALTER COLUMN currency DROP DEFAULT;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.default_deal_currency() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.currency IS NULL THEN
    SELECT currency INTO NEW.currency FROM public.account WHERE id = NEW.account_id;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.default_deal_currency() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.default_deal_currency() TO rawr_app;
--> statement-breakpoint

DROP TRIGGER IF EXISTS deal_default_currency ON public.deal;
--> statement-breakpoint
CREATE TRIGGER deal_default_currency
  BEFORE INSERT ON public.deal
  FOR EACH ROW EXECUTE FUNCTION rawr.default_deal_currency();
--> statement-breakpoint

-- Read with the rest of the membership, so the session carries it for nothing.
DROP FUNCTION IF EXISTS rawr.memberships_for_user(uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rawr.memberships_for_user(p_user_id uuid)
 RETURNS TABLE(account_id uuid, account_slug text, account_name text, hosted_domain text,
               user_id uuid, email text, display_name text, avatar_url text,
               is_super_admin boolean, view_hubs public.rawr_hub[], edit_hubs public.rawr_hub[],
               critical_grants public.rawr_critical_action[],
               joined_at timestamptz, sessions_valid_after timestamptz, account_timezone text,
               account_currency text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT a.id, a.slug, a.name, a.google_hosted_domain,
           u.id, u.email, u.name, u.avatar_url,
           m.is_super_admin, m.view_hubs, m.edit_hubs, m.critical_grants,
           m.created_at, greatest(u.sessions_valid_after, m.sessions_valid_after), a.timezone,
           a.currency
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
