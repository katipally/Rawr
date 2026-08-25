-- F5 | MCP server. Per-user agent tokens and the idempotency ledger behind them.
--
-- One mechanism beyond the two tables: a token arrives on a request that has no
-- session and does not yet know which tenant it belongs to, exactly like a booking
-- cancel link. So the lookup is a security-definer function that takes a hash and
-- answers with ids and a role and nothing else. The role is read live from the
-- membership rather than stored on the token, so a demotion lands on the next call.

CREATE TABLE IF NOT EXISTS public.mcp_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL,
  prefix text NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Globally unique, not per workspace: a hash collision across tenants would make
-- one workspace's token open another's, and the index is what makes that
-- impossible rather than unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS mcp_token_hash_key ON public.mcp_token (token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mcp_token_user_idx
  ON public.mcp_token (workspace_id, user_id, created_at DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.mcp_call (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  token_id uuid NOT NULL REFERENCES public.mcp_token(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  tool text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS mcp_call_key_key
  ON public.mcp_call (workspace_id, token_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mcp_call_age_idx ON public.mcp_call (created_at);
--> statement-breakpoint

-- The request carrying a token has no session and no workspace yet, so this is the
-- one question answerable outside a tenant scope. It returns the hash's owner and
-- their current role; it never returns the token, and it answers nothing at all for
-- a revoked one, which is what makes revocation immediate rather than cached.
CREATE OR REPLACE FUNCTION rawr.mcp_token_owner(p_hash text)
  RETURNS TABLE (
    token_id uuid,
    workspace_id uuid,
    workspace_slug text,
    workspace_name text,
    user_id uuid,
    user_email text,
    user_name text,
    role public.rawr_role
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT t.id, t.workspace_id, w.slug, w.name, u.id, u.email, u.name, m.role
      FROM public.mcp_token t
      JOIN public.workspace w ON w.id = t.workspace_id
      JOIN public.user_account u ON u.id = t.user_id
      JOIN public.membership m ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id
     WHERE t.token_hash = p_hash AND t.revoked_at IS NULL
$$;
--> statement-breakpoint

-- Separate from the lookup because the lookup is STABLE and runs on every call:
-- a write inside it would make every read a write.
CREATE OR REPLACE FUNCTION rawr.mcp_token_used(p_token_id uuid)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE public.mcp_token SET last_used_at = now() WHERE id = p_token_id
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.mcp_token_owner(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rawr.mcp_token_used(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.mcp_token_owner(text) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.mcp_token_used(uuid) TO rawr_app;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
