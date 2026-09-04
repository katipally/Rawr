-- The organisation screens count seats and list who sits where, and both read
-- membership. But membership is a tenant table, so its policy only admits the
-- pinned workspace: from an organisation scope every workspace read "0 members"
-- and every person read as having no seats.
--
-- A second permissive policy rather than a change to the generated one, because
-- apply_tenancy() rewrites `rawr_tenant` on every migration and would drop an
-- edit made there. Policies are OR-ed, so this widens without loosening the
-- workspace rule: a row is visible to its own workspace, or to the organisation
-- that owns that workspace.

ALTER TABLE public.membership ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rawr_org_scope ON public.membership;
CREATE POLICY rawr_org_scope ON public.membership
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace w
       WHERE w.id = membership.workspace_id
         AND w.organisation_id = rawr.current_organisation()
    )
  );
