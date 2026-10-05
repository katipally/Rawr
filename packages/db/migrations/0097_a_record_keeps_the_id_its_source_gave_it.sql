-- An import matched a record on its email, its domain or its name, and ignored the
-- id HubSpot gave it. A contact without an email, a company without a domain and
-- two deals with one name were created again by every run of the same file.
--
-- A deal had nowhere to keep an id at all; a contact and a company already carry
-- `external_ids`. The id is unique per account among live records, so a second
-- record cannot claim it and the importer can rely on a match being the one record.
-- A soft-deleted record releases it, so a file can bring that record back.
--
-- Plain CREATE INDEX for the reason 0096 gives. Every existing row has an empty
-- `external_ids`, so none is in these indexes yet and each build reads its table
-- once, which is under a second at today's sizes.
ALTER TABLE public.deal ADD COLUMN IF NOT EXISTS external_ids jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS contact_hubspot_id_key
  ON public.contact (account_id, (external_ids ->> 'hubspot'))
  WHERE external_ids ->> 'hubspot' IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS company_hubspot_id_key
  ON public.company (account_id, (external_ids ->> 'hubspot'))
  WHERE external_ids ->> 'hubspot' IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS deal_hubspot_id_key
  ON public.deal (account_id, (external_ids ->> 'hubspot'))
  WHERE external_ids ->> 'hubspot' IS NOT NULL AND deleted_at IS NULL;
