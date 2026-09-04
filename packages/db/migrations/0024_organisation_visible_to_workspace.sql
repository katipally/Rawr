-- An organisation was visible only to a caller that had pinned the organisation
-- scope. But a workspace-scoped read legitimately needs one fact from its owner:
-- which mail domain counts as internal. That read is not cross-tenant, it is a
-- workspace asking about itself one level up.
--
-- Still not readable from nowhere: either the organisation is the pinned one, or
-- it owns the pinned workspace.

DROP POLICY IF EXISTS rawr_org ON public.organisation;
CREATE POLICY rawr_org ON public.organisation
  USING (
    id = rawr.current_organisation()
    OR EXISTS (
      SELECT 1 FROM public.workspace w
       WHERE w.organisation_id = organisation.id
         AND w.id = rawr.current_workspace()
    )
  )
  WITH CHECK (id = rawr.current_organisation());
