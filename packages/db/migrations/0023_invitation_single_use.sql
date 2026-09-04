-- An accepted invitation was still redeemable: the lookup filtered on revoked and
-- expired but not on accepted, so clicking the link a second time re-seated the
-- person. That matters after an admin has removed the seat again, because the old
-- mail in somebody's inbox would put it back.
--
-- One use, then the link is spent.

CREATE OR REPLACE FUNCTION rawr.accept_invitation(p_token_hash text, p_user_id uuid)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_invite public.invitation%ROWTYPE;
  v_email text;
BEGIN
  SELECT * INTO v_invite FROM public.invitation
   WHERE token_hash = p_token_hash
     AND accepted_at IS NULL
     AND revoked_at IS NULL
     AND expires_at > now();
  IF v_invite.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT lower(email) INTO v_email FROM public.user_account WHERE id = p_user_id;
  -- The invitation names an address; the person signing in must be that person.
  IF v_email IS DISTINCT FROM lower(v_invite.email) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.organisation_membership (organisation_id, user_id, role, state, invited_by)
  VALUES (v_invite.organisation_id, p_user_id, v_invite.org_role, 'active', v_invite.invited_by)
  ON CONFLICT (organisation_id, user_id) DO UPDATE
    SET state = 'active',
        role = CASE WHEN excluded.role = 'org_admin' THEN 'org_admin'
                    ELSE public.organisation_membership.role END;

  IF v_invite.workspace_id IS NOT NULL AND v_invite.workspace_role IS NOT NULL THEN
    INSERT INTO public.membership (workspace_id, user_id, role)
    VALUES (v_invite.workspace_id, p_user_id, v_invite.workspace_role)
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role;
  END IF;

  UPDATE public.invitation SET accepted_at = now() WHERE id = v_invite.id;
  RETURN v_invite.organisation_id;
END
$$;
