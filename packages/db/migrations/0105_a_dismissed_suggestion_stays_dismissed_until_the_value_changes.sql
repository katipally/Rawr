-- Dismissing an enrichment suggestion deleted it and remembered nothing, so the next
-- Enrich offered the same value again. A dismissal now keeps the value the provider
-- gave. While the provider keeps giving that value, it is not suggested again; the
-- moment it gives a different one, the dismissal is cleared.
--
-- One row per field of a record, the same key the suggestion uses. A new table with
-- nothing to backfill: suggestions dismissed before this release were not recorded.

CREATE TABLE IF NOT EXISTS public.enrichment_dismissal (
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  entity text NOT NULL,
  entity_id uuid NOT NULL,
  field_key text NOT NULL,
  dismissed_value text NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, entity, entity_id, field_key)
);
--> statement-breakpoint

COMMENT ON TABLE public.enrichment_dismissal IS
  'A value a person dismissed as an enrichment suggestion, held so the same provider value is not offered again.';
--> statement-breakpoint

SELECT rawr.apply_tenancy();
