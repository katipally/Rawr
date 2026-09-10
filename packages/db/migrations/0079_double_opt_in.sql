-- Confirmed opt-in.
--
-- A ticked box on a form is somebody's word that the address is theirs. Double
-- opt-in is the proof: nothing is sent to that address until a link in a mail to
-- it has been clicked, which is what stops a typo, a competitor's address and a
-- harvested list from becoming a subscriber.
--
-- It is per type, not per account. A product changelog somebody asked for and a
-- marketing newsletter are not the same promise, and requiring a confirmation on
-- the first would cost sign-ups for no gain.
--
-- Waiting for a confirmation is deliberately not a fourth state. 'unspecified'
-- already means "has not said", which is exactly true of somebody who has been
-- asked and not answered, and every list, every send and every push already
-- excludes them. A fourth value would need each of those to learn about it, and
-- one that forgot would mail an unconfirmed address. The token is what says a
-- confirmation is outstanding; confirmed_at is what says one arrived.

ALTER TABLE public.subscription_type
  ADD COLUMN IF NOT EXISTS double_opt_in boolean NOT NULL DEFAULT false;
--> statement-breakpoint

COMMENT ON COLUMN public.subscription_type.double_opt_in IS
  'When true, a form opt-in only asks; the contact is subscribed by the link in the confirmation mail.';
--> statement-breakpoint

ALTER TABLE public.subscription_state
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  -- Opaque and random, like the unsubscribe token beside it: a signed token
  -- cannot be withdrawn, and this one has to stop working the moment it is used.
  ADD COLUMN IF NOT EXISTS confirm_token text;
--> statement-breakpoint

-- Partial, because almost every row has no outstanding confirmation and a token
-- is only ever looked up by itself.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_state_confirm_token_key
  ON public.subscription_state (confirm_token) WHERE confirm_token IS NOT NULL;
--> statement-breakpoint

-- The confirm link arrives with no session and no account, exactly as an
-- unsubscribe link does, so the account is resolved from the token itself
-- through a definer function rather than taken from the URL.
CREATE OR REPLACE FUNCTION rawr.account_for_confirm_token(p_token text)
  RETURNS TABLE(id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT s.account_id FROM public.subscription_state s WHERE s.confirm_token = p_token LIMIT 1
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.account_for_confirm_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.account_for_confirm_token(text) TO rawr_app;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
