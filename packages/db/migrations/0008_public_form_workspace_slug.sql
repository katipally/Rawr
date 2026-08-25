-- The Slack notification deep-links to the contact it created, and a CRM link
-- addresses its tenant in the path. The public edge therefore needs the
-- workspace slug at the same moment it resolves the form, not a second query
-- later. Both resolvers return it; nothing else about them changes.

-- The return columns change, and Postgres refuses to replace a function's
-- signature in place, so both are dropped first.
DROP FUNCTION IF EXISTS rawr.public_form(uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS rawr.public_form_by_slug(text, text);
--> statement-breakpoint

CREATE FUNCTION rawr.public_form(p_form_id uuid)
  RETURNS TABLE (
    workspace_id uuid,
    workspace_slug text,
    form_id uuid,
    name text,
    slug text,
    schema jsonb,
    settings jsonb,
    is_active boolean
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT f.workspace_id, w.slug, f.id, f.name, f.slug, f.schema, f.settings, f.is_active
      FROM public.form f
      JOIN public.workspace w ON w.id = f.workspace_id
     WHERE f.id = p_form_id
$$;
--> statement-breakpoint

CREATE FUNCTION rawr.public_form_by_slug(p_workspace_slug text, p_slug text)
  RETURNS TABLE (
    workspace_id uuid,
    workspace_slug text,
    form_id uuid,
    name text,
    slug text,
    schema jsonb,
    settings jsonb,
    is_active boolean
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT f.workspace_id, w.slug, f.id, f.name, f.slug, f.schema, f.settings, f.is_active
      FROM public.form f
      JOIN public.workspace w ON w.id = f.workspace_id
     WHERE w.slug = p_workspace_slug AND f.slug = p_slug
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.public_form(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION rawr.public_form_by_slug(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.public_form(uuid) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.public_form_by_slug(text, text) TO rawr_app;
