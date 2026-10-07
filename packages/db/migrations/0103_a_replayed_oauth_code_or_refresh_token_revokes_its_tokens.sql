-- OAuth 2.1 replay (RFC 6749 4.1.2, RFC 9700): a code presented twice, or a rotated
-- refresh token presented again, revokes the token it produced.
--
-- A redeemed code used to be deleted, and a rotated refresh token was overwritten,
-- so a replay found nothing and nothing tied it to the token it had made. Now a
-- redeemed code stays as a tombstone: redeemed_at marks the first use, replayed_at
-- a second, and token_id links it to the token it issued. prev_refresh_hash keeps
-- the hash a rotation replaced, so presenting it again is recognised.
--
-- Only columns, indexes and functions change. No row is rewritten, and rows that
-- exist already keep working: an unredeemed code has no redeemed_at, and a token
-- that has never rotated has no prev_refresh_hash. Run this before the release
-- that redeems codes through the functions below.
ALTER TABLE public.mcp_oauth_code ADD COLUMN IF NOT EXISTS redeemed_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.mcp_oauth_code ADD COLUMN IF NOT EXISTS replayed_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.mcp_oauth_code
  ADD COLUMN IF NOT EXISTS token_id uuid REFERENCES public.mcp_token(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mcp_oauth_code_token_id_idx ON public.mcp_oauth_code (token_id);
--> statement-breakpoint
ALTER TABLE public.mcp_token ADD COLUMN IF NOT EXISTS prev_refresh_hash text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mcp_token_prev_refresh_key ON public.mcp_token (prev_refresh_hash);
--> statement-breakpoint

-- The first presentation marks the code redeemed. A later one marks it replayed and
-- returns replayed = true with the token already linked to it, if any. The row is
-- locked first, so two simultaneous presentations are ordered: one is the first use,
-- the other sees redeemed_at set.
DROP FUNCTION IF EXISTS rawr.mcp_code_redeem(text);
--> statement-breakpoint
CREATE FUNCTION rawr.mcp_code_redeem(p_hash text)
  RETURNS TABLE (
    account_id uuid,
    user_id uuid,
    client_id text,
    code_challenge text,
    redirect_uri text,
    resource text,
    scope text,
    expires_at timestamptz,
    replayed boolean,
    token_id uuid
  )
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c public.mcp_oauth_code%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.mcp_oauth_code WHERE code_hash = p_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF c.redeemed_at IS NULL THEN
    UPDATE public.mcp_oauth_code SET redeemed_at = now() WHERE id = c.id;
  ELSE
    UPDATE public.mcp_oauth_code SET replayed_at = now() WHERE id = c.id;
  END IF;
  RETURN QUERY SELECT c.account_id, c.user_id, c.client_id, c.code_challenge, c.redirect_uri,
                      c.resource, c.scope, c.expires_at, c.redeemed_at IS NOT NULL, c.token_id;
END
$$;
--> statement-breakpoint

-- Ties a code to the token it issued. Returns true when the code was presented again
-- while that token was being issued, so the caller revokes the token it just made.
CREATE OR REPLACE FUNCTION rawr.mcp_code_link(p_hash text, p_token_id uuid)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE public.mcp_oauth_code c SET token_id = p_token_id WHERE c.code_hash = p_hash
    RETURNING c.replayed_at IS NOT NULL
$$;
--> statement-breakpoint

-- A refresh token that is current or was just rotated away. replayed is true only for
-- the rotated one, which is the signal to revoke the family.
DROP FUNCTION IF EXISTS rawr.mcp_refresh_owner(text);
--> statement-breakpoint
CREATE FUNCTION rawr.mcp_refresh_owner(p_hash text)
  RETURNS TABLE (token_id uuid, account_id uuid, user_id uuid, client_id text, scope text, replayed boolean)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT t.id, t.account_id, t.user_id, t.client_id, t.scope, t.refresh_hash IS DISTINCT FROM p_hash
      FROM public.mcp_token t
      JOIN public.membership m ON m.account_id = t.account_id AND m.user_id = t.user_id
     WHERE (t.refresh_hash = p_hash OR t.prev_refresh_hash = p_hash) AND t.revoked_at IS NULL
$$;
--> statement-breakpoint

-- A code that expired without issuing a token can never be redeemed to a token, so
-- its row goes. A code that issued one stays for as long as the link does.
CREATE OR REPLACE FUNCTION rawr.mcp_code_purge()
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    DELETE FROM public.mcp_oauth_code WHERE expires_at < now() AND token_id IS NULL
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.mcp_code_redeem(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rawr.mcp_code_link(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION rawr.mcp_refresh_owner(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rawr.mcp_code_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.mcp_code_redeem(text) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.mcp_code_link(text, uuid) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.mcp_refresh_owner(text) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.mcp_code_purge() TO rawr_app;
