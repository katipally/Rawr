-- A hub grant was only ever read to hide navigation. The record policies already
-- ask `visible_owners` who may be seen; this makes the answer say none at all to a
-- seat that holds neither the view nor the edit grant for the hub, so a member
-- with no hubs reads no contacts, companies, deals or custom records however they
-- ask: a page, the export, a report or an agent token.
--
-- It also closes the fail-open direction. An actor with no active seat in the
-- account used to read as unrestricted; it now reads as nobody. Only a session
-- with no actor at all (the worker, a webhook, a public form) is unrestricted,
-- and the tenant policy still holds that inside one account.
--
-- Reads only. The write grant is asked in the layer before the statement runs,
-- and the edit scope is still what the WITH CHECK applies.
CREATE OR REPLACE FUNCTION rawr.visible_owners(hub text, writing boolean DEFAULT false)
RETURNS uuid[]
LANGUAGE sql
STABLE
AS $$
  WITH seat AS (
    SELECT m.user_id, m.is_super_admin,
           (m.view_hubs || m.edit_hubs) @> ARRAY[hub::public.rawr_hub] AS holds_hub,
           (CASE WHEN writing THEN m.edit_scopes ELSE m.view_scopes END ->> hub)::public.rawr_scope AS scope
      FROM public.membership m
     WHERE m.account_id = rawr.current_account()
       AND m.user_id = rawr.current_actor()
       AND m.state = 'active'
  )
  SELECT CASE
    WHEN rawr.current_actor() IS NULL THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM seat) THEN ARRAY[]::uuid[]
    WHEN (SELECT is_super_admin FROM seat) THEN NULL
    WHEN NOT writing AND NOT (SELECT holds_hub FROM seat) THEN ARRAY[]::uuid[]
    WHEN (SELECT scope FROM seat) = 'own' THEN ARRAY[(SELECT user_id FROM seat)]
    WHEN (SELECT scope FROM seat) = 'team' THEN COALESCE((
      SELECT array_agg(DISTINCT mine.user_id)
        FROM public.team_member mine
        JOIN public.team_member ours ON ours.team_id = mine.team_id
       WHERE ours.user_id = (SELECT user_id FROM seat)
    ), ARRAY[(SELECT user_id FROM seat)])
    ELSE NULL
  END
$$;
