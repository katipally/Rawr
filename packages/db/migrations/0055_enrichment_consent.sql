-- Nothing is enriched until a person says so.
--
-- A request now waits in two states: written when a record gains its match key,
-- approved when somebody has seen how many records it covers and accepted the
-- credit cost. The worker drains only approved rows, so an import, a form burst
-- or a bad paste can never spend a provider's credits on its own.

ALTER TABLE public.enrichment_request
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;
--> statement-breakpoint

-- The dispatcher's whole query: approved rows, oldest first. Partial, because
-- the rows still waiting for a person are the ones it must not see.
CREATE INDEX IF NOT EXISTS enrichment_request_approved_idx
  ON public.enrichment_request (approved_at)
  WHERE approved_at IS NOT NULL;
--> statement-breakpoint

-- Anything already queued before this migration was queued under the old
-- always-run rule. It waits for consent like everything else rather than being
-- grandfathered into spending credits.
DROP INDEX IF EXISTS public.enrichment_request_due_idx;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS enrichment_request_waiting_idx
  ON public.enrichment_request (workspace_id, requested_at)
  WHERE approved_at IS NULL;
