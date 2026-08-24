-- Layer 3 of the tenancy design. Applied by a function, never by hand, so a new
-- tenant table cannot be added without row level security coming with it.

CREATE SCHEMA IF NOT EXISTS rawr;
GRANT USAGE ON SCHEMA rawr TO rawr_app;

-- Reads the workspace set by the data access layer. Returns NULL rather than
-- raising when nothing is set, so an unscoped query returns zero rows.
CREATE OR REPLACE FUNCTION rawr.current_workspace() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('rawr.workspace_id', true), '')::uuid
$$;
--> statement-breakpoint

-- Every public table carrying a workspace_id column, found by inspection rather
-- than by a list somebody has to remember to update.
CREATE OR REPLACE FUNCTION rawr.apply_tenancy() RETURNS int
  LANGUAGE plpgsql AS $fn$
DECLARE
  t record;
  applied int := 0;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
                         AND a.attname = 'workspace_id'
                         AND a.attnum > 0
                         AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS rawr_tenant ON public.%I', t.relname);
    EXECUTE format(
      'CREATE POLICY rawr_tenant ON public.%I USING (workspace_id = rawr.current_workspace())'
      || ' WITH CHECK (workspace_id = rawr.current_workspace())', t.relname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO rawr_app', t.relname);
    applied := applied + 1;
  END LOOP;

  -- Append only. History cannot be rewritten even with a valid session.
  REVOKE UPDATE, DELETE ON public.audit_log FROM rawr_app;

  RETURN applied;
END
$fn$;
--> statement-breakpoint

-- workspace and user_account carry no workspace_id, so they need policies written
-- once by hand. Both are still FORCE RLS and still invisible without a scope set.
ALTER TABLE public.workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rawr_self ON public.workspace;
CREATE POLICY rawr_self ON public.workspace USING (id = rawr.current_workspace());
GRANT SELECT ON public.workspace TO rawr_app;
--> statement-breakpoint

ALTER TABLE public.user_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_account FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rawr_member ON public.user_account;
-- Visible only to a workspace that person actually belongs to, which is what stops
-- the owner dropdown from leaking the staff list of another tenant.
CREATE POLICY rawr_member ON public.user_account USING (
  EXISTS (
    SELECT 1 FROM public.membership m
     WHERE m.user_id = user_account.id
       AND m.workspace_id = rawr.current_workspace()
  )
);
GRANT SELECT ON public.user_account TO rawr_app;
--> statement-breakpoint

-- Sign-in has to answer "which workspaces does this person belong to" before any
-- workspace is chosen, which is the one question RLS cannot answer. This function
-- is the only sanctioned way to ask it: it takes a google_sub, never a workspace,
-- and returns nothing but the memberships of that one person.
CREATE OR REPLACE FUNCTION rawr.memberships_for_google_sub(p_google_sub text)
  RETURNS TABLE (
    workspace_id uuid,
    workspace_slug text,
    workspace_name text,
    hosted_domain text,
    user_id uuid,
    email text,
    display_name text,
    avatar_url text,
    role public.rawr_role
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT w.id, w.slug, w.name, w.google_hosted_domain,
           u.id, u.email, u.name, u.avatar_url, m.role
      FROM public.user_account u
      JOIN public.membership m ON m.user_id = u.id
      JOIN public.workspace w ON w.id = m.workspace_id
     WHERE u.google_sub = p_google_sub
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.memberships_for_google_sub(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.memberships_for_google_sub(text) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.current_workspace() TO rawr_app;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
