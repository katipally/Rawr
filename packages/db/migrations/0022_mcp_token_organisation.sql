-- A token acts inside one workspace, and that workspace now belongs to an
-- organisation. The lookup returns it so the session the MCP server builds is a
-- real one rather than one with the organisation fields invented. A token held by
-- somebody whose access has ended stops resolving here, the same as a cookie does.
DROP FUNCTION IF EXISTS rawr.mcp_token_owner(text);
CREATE FUNCTION rawr.mcp_token_owner(p_hash text)
  RETURNS TABLE (
    token_id uuid,
    workspace_id uuid,
    workspace_slug text,
    workspace_name text,
    organisation_id uuid,
    organisation_slug text,
    organisation_name text,
    org_role public.rawr_org_role,
    user_id uuid,
    user_email text,
    user_name text,
    role public.rawr_role
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT t.id, t.workspace_id, w.slug, w.name,
           o.id, o.slug, o.name, om.role,
           u.id, u.email, u.name, m.role
      FROM public.mcp_token t
      JOIN public.workspace w ON w.id = t.workspace_id
      JOIN public.organisation o ON o.id = w.organisation_id
      JOIN public.user_account u ON u.id = t.user_id
      JOIN public.membership m ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id
      JOIN public.organisation_membership om
        ON om.organisation_id = o.id AND om.user_id = t.user_id AND om.state = 'active'
     WHERE t.token_hash = p_hash AND t.revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION rawr.mcp_token_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.mcp_token_owner(text) TO rawr_app;
