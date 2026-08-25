-- The consent endpoint has no session and no form id to resolve a workspace
-- from, only the site key the embed script carries. Same pattern as the form
-- resolvers: a security-definer function that takes the key and returns nothing
-- but an id, so there is no path from a public request to tenant data.

CREATE OR REPLACE FUNCTION rawr.workspace_for_site(p_site_key text)
  RETURNS TABLE (id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT w.id FROM public.workspace w WHERE w.slug = p_site_key
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.workspace_for_site(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.workspace_for_site(text) TO rawr_app;
