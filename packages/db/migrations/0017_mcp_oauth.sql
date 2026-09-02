-- F5 | OAuth 2.1 for the MCP endpoint, so claude.ai and Claude Code connect the
-- way they connect to any other server: sign in to Rawr, approve, done. A token
-- issued this way is an ordinary mcp_token row that expires and can be refreshed;
-- everything downstream of the credential is unchanged.
--
-- Also: a message remembers which mailbox read it, because a Gmail message id is
-- only meaningful inside the mailbox that issued it, and the thread viewer fetches
-- bodies on demand through that mailbox.

ALTER TABLE public.mcp_token ADD COLUMN IF NOT EXISTS client_id text;
--> statement-breakpoint
ALTER TABLE public.mcp_token ADD COLUMN IF NOT EXISTS scope text;
--> statement-breakpoint
ALTER TABLE public.mcp_token ADD COLUMN IF NOT EXISTS expires_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.mcp_token ADD COLUMN IF NOT EXISTS refresh_hash text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mcp_token_refresh_key ON public.mcp_token (refresh_hash);
--> statement-breakpoint

-- OAuth clients. Registered dynamically (RFC 7591) or resolved from a Client ID
-- Metadata Document, which is cached here under its URL. No workspace_id on
-- purpose: a client is not tenant data, it is a public name and a redirect list.
CREATE TABLE IF NOT EXISTS public.mcp_client (
  id text PRIMARY KEY,
  name text NOT NULL,
  redirect_uris text[] NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT 'dcr',
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mcp_client TO rawr_app;
--> statement-breakpoint

-- One authorization code. Written by a signed-in person approving a client, read
-- once by the token endpoint through the redeem function below, then gone.
CREATE TABLE IF NOT EXISTS public.mcp_oauth_code (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  code_hash text NOT NULL,
  code_challenge text NOT NULL,
  redirect_uri text NOT NULL,
  resource text,
  scope text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mcp_oauth_code_hash_key ON public.mcp_oauth_code (code_hash);
--> statement-breakpoint

-- The token endpoint has no session and no tenant, exactly like a bearer call.
-- Redeeming deletes the row in the same statement, so a code presented twice is
-- refused the second time (OAuth 2.1 §4.1.2) without a separate "used" flag.
CREATE OR REPLACE FUNCTION rawr.mcp_code_redeem(p_hash text)
  RETURNS TABLE (
    workspace_id uuid,
    user_id uuid,
    client_id text,
    code_challenge text,
    redirect_uri text,
    resource text,
    scope text,
    expires_at timestamptz
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    DELETE FROM public.mcp_oauth_code c
     WHERE c.code_hash = p_hash
    RETURNING c.workspace_id, c.user_id, c.client_id, c.code_challenge, c.redirect_uri,
              c.resource, c.scope, c.expires_at
$$;
--> statement-breakpoint

-- Which token a refresh token belongs to, if it is still live.
CREATE OR REPLACE FUNCTION rawr.mcp_refresh_owner(p_hash text)
  RETURNS TABLE (token_id uuid, workspace_id uuid, user_id uuid, client_id text, scope text)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT t.id, t.workspace_id, t.user_id, t.client_id, t.scope
      FROM public.mcp_token t
      JOIN public.membership m ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id
     WHERE t.refresh_hash = p_hash AND t.revoked_at IS NULL
$$;
--> statement-breakpoint

-- An expired access token answers nothing, the same as a revoked one.
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
       AND (t.expires_at IS NULL OR t.expires_at > now())
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.mcp_code_redeem(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rawr.mcp_refresh_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.mcp_code_redeem(text) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.mcp_refresh_owner(text) TO rawr_app;
--> statement-breakpoint

ALTER TABLE public.message
  ADD COLUMN IF NOT EXISTS mailbox_id uuid REFERENCES public.mailbox(id) ON DELETE SET NULL;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
