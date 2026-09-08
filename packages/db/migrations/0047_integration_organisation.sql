-- One credential per organisation, shared by its workspaces. A Slack bot token, a
-- Brevo key or an Apollo key is issued to a company, not to one of its
-- workspaces, and two workspaces each holding half a connection is how a lead
-- notification silently stops arriving.
--
-- Reading stays a workspace act, because every provider client reads its
-- credential inside withWorkspace. Writing becomes an organisation act.

-- rawr_tenant references workspace_id, and a policy is a dependent object, so the
-- drop below fails unless this goes first.
DROP POLICY IF EXISTS rawr_tenant ON public.integration;
--> statement-breakpoint

ALTER TABLE public.integration
  ADD COLUMN organisation_id uuid REFERENCES public.organisation(id) ON DELETE CASCADE;
--> statement-breakpoint

UPDATE public.integration i
   SET organisation_id = w.organisation_id
  FROM public.workspace w
 WHERE w.id = i.workspace_id;
--> statement-breakpoint

-- Two workspaces in one organisation may each hold a 'slack' row. One wins, and
-- the rule is deterministic so a re-run picks the same one: a configured row
-- beats an empty one, a working row beats a broken one, and the most recently
-- successful beats the rest. "Most recently ok" rather than "newest" because the
-- winner's config carries the webhook token already pasted at Brevo and
-- Woodpecker, and choosing the other row silently breaks that URL.
CREATE TEMP TABLE integration_winner AS
SELECT DISTINCT ON (organisation_id, kind) id, organisation_id, kind
  FROM public.integration
 ORDER BY organisation_id, kind,
          (secret_ref IS NOT NULL) DESC,
          array_position(ARRAY['connected','degraded','revoked','unconfigured']::text[], state::text),
          last_ok_at DESC NULLS LAST,
          created_at DESC,
          id;
--> statement-breakpoint

-- The losers' children are repointed before anything is deleted. outbound_call
-- cascades from integration, and an idempotency ledger deleted by a migration is
-- a retry that double-writes at the provider months later.
UPDATE public.outbound_call c
   SET integration_id = w.id
  FROM public.integration i
  JOIN integration_winner w ON w.organisation_id = i.organisation_id AND w.kind = i.kind
 WHERE c.integration_id = i.id AND i.id <> w.id;
--> statement-breakpoint

UPDATE public.dead_letter d
   SET integration_id = w.id
  FROM public.integration i
  JOIN integration_winner w ON w.organisation_id = i.organisation_id AND w.kind = i.kind
 WHERE d.integration_id = i.id AND i.id <> w.id;
--> statement-breakpoint

-- What was collapsed, where an organisation admin can read it. A credential that
-- stops being used should not vanish without a sentence, and this is the row that
-- explains a provider URL that stopped verifying at cutover.
INSERT INTO public.organisation_audit_log
  (organisation_id, actor_id, actor_kind, entity, entity_id, action, before)
SELECT i.organisation_id, NULL, 'job', 'integration', i.id, 'collapse_to_organisation',
       jsonb_build_object('kind', i.kind, 'workspaceId', i.workspace_id, 'keptId', w.id)
  FROM public.integration i
  JOIN integration_winner w ON w.organisation_id = i.organisation_id AND w.kind = i.kind
 WHERE i.id <> w.id;
--> statement-breakpoint

DELETE FROM public.integration i
 USING integration_winner w
 WHERE w.organisation_id = i.organisation_id AND w.kind = i.kind AND i.id <> w.id;
--> statement-breakpoint

ALTER TABLE public.integration ALTER COLUMN organisation_id SET NOT NULL;
--> statement-breakpoint

-- Who connected it, for the Connected Apps table. Null for everything that
-- existed before this migration, and for anything a job connects.
ALTER TABLE public.integration
  ADD COLUMN installed_by uuid REFERENCES public.user_account(id) ON DELETE SET NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS integration_kind_key;
--> statement-breakpoint
ALTER TABLE public.integration DROP COLUMN workspace_id;
--> statement-breakpoint
-- The same name, because the save is an upsert whose arbiter drizzle resolves by
-- columns, and the screen would otherwise start inserting duplicates.
CREATE UNIQUE INDEX integration_kind_key ON public.integration (organisation_id, kind);
--> statement-breakpoint

-- A retry that survives a disconnect is worth more than a tidy foreign key. The
-- ledger keeps its rows and forgets which connection made them, the way
-- dead_letter already does.
ALTER TABLE public.outbound_call
  DROP CONSTRAINT IF EXISTS outbound_call_integration_id_integration_id_fk;
--> statement-breakpoint
ALTER TABLE public.outbound_call
  ADD CONSTRAINT outbound_call_integration_id_integration_id_fk
  FOREIGN KEY (integration_id) REFERENCES public.integration(id) ON DELETE SET NULL;
--> statement-breakpoint

-- Which company owns the workspace this transaction is pinned to. Not SECURITY
-- DEFINER: 0021 already widened the workspace policy to admit the pinned
-- workspace's own row, so an ordinary stable function sees exactly the one row it
-- needs, and a definer would add a privilege-escalation surface for nothing.
CREATE OR REPLACE FUNCTION rawr.workspace_organisation() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT w.organisation_id FROM public.workspace w WHERE w.id = rawr.current_workspace()
  $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.workspace_organisation() TO rawr_app;
--> statement-breakpoint

ALTER TABLE public.integration ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.integration FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Writing is an organisation act: the credential is the company's.
DROP POLICY IF EXISTS rawr_org ON public.integration;
--> statement-breakpoint
CREATE POLICY rawr_org ON public.integration
  USING (organisation_id = rawr.current_organisation())
  WITH CHECK (organisation_id = rawr.current_organisation());
--> statement-breakpoint

-- Reading is not. FOR SELECT and not FOR ALL: a DELETE is checked against USING
-- alone, so one combined policy would let any workspace transaction delete the
-- organisation's shared credential.
DROP POLICY IF EXISTS rawr_workspace_read ON public.integration;
--> statement-breakpoint
CREATE POLICY rawr_workspace_read ON public.integration
  FOR SELECT
  USING (organisation_id = rawr.workspace_organisation());
--> statement-breakpoint

-- apply_tenancy() finds this table by its workspace_id column and issues the
-- grants along with the policy. Without that column it skips the table entirely,
-- so the grants are written by hand from here on.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.integration TO rawr_app;
--> statement-breakpoint

-- Health is the one write a workspace transaction must still make: every provider
-- client records the provider's real answer as it goes, and the unauthenticated
-- webhook edge records a rejected signature. Row level security cannot say "these
-- four columns only" — an update allowed to touch last_error is equally allowed
-- to touch secret_ref — so this function says it instead, and is the only write
-- path from that scope.
CREATE OR REPLACE FUNCTION rawr.record_integration_health(
  p_kind text, p_ok boolean, p_error text, p_disconnected boolean
) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.integration i
     SET last_ok_at    = CASE WHEN p_ok THEN now() ELSE i.last_ok_at END,
         last_error    = CASE WHEN p_ok THEN NULL ELSE left(p_error, 2000) END,
         last_error_at = CASE WHEN p_ok THEN NULL ELSE now() END,
         state         = CASE WHEN p_ok THEN 'connected'
                              WHEN p_disconnected THEN 'revoked'
                              ELSE 'degraded' END::public.rawr_integration_state
   WHERE i.kind = p_kind
     AND i.organisation_id = rawr.workspace_organisation()
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rawr.record_integration_health(text, boolean, text, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.record_integration_health(text, boolean, text, boolean) TO rawr_app;
