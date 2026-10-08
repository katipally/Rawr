-- A merge threw the absorbed company's domain away. Every contact who wrote from that
-- domain then stopped matching the company they belonged to, and mail from it was
-- filed nowhere. The domain now moves to the survivor as an alias, and matching looks
-- at a company's primary domain and its aliases alike.
--
-- One row per alias per account. The domain is unique within the account, the same
-- as a primary domain is among live companies, so a domain answers for one company.
-- It is stored lowercase, which the check enforces, because every lookup compares
-- exact text. Deleting a company for good removes its aliases with it.
--
-- A new table with no rows to backfill: merges made before this release are not
-- recoverable from the survivor, so nothing is copied from them.

CREATE TABLE IF NOT EXISTS public.company_domain (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.company(id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain = lower(domain)),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE public.company_domain IS
  'A domain a merged company owned, kept as an alias of the company that absorbed it. Matches people and mail to that company the same way its primary domain does.';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS company_domain_account_key
  ON public.company_domain (account_id, domain);
--> statement-breakpoint

-- Deleting a company looks its aliases up by company.
CREATE INDEX IF NOT EXISTS company_domain_company_idx
  ON public.company_domain (company_id);
--> statement-breakpoint

SELECT rawr.apply_tenancy();
--> statement-breakpoint

-- An alias has no owner of its own, so it is read through the company it names, the
-- way a company's own rows are read. Restrictive, so it narrows the account policy
-- apply_tenancy writes rather than replacing it: apply_tenancy runs after every
-- migration and rewrites that policy, but leaves policies with another name alone.
DROP POLICY IF EXISTS company_domain_scope ON public.company_domain;
--> statement-breakpoint
CREATE POLICY company_domain_scope ON public.company_domain
  AS RESTRICTIVE FOR ALL
  USING (NOT (SELECT rawr.scoped()) OR NOT rawr.record_hidden('company', company_id));
